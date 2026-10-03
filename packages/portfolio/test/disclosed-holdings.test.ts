import { describe, expect, it } from 'vitest';
import { compareDisclosedHoldings } from '@totalfinance/portfolio';
import { compareDisclosedHoldings as granular } from '@totalfinance/portfolio/disclosed-holdings';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import {
  disclosedHolding as holding,
  disclosedInput,
  disclosedSnapshot as snapshot,
} from '../../../tools/first-touch/fixtures/disclosed-holdings.js';

const inputWith = (before: ReturnType<typeof holding>[], after: ReturnType<typeof holding>[]) => ({
  ...disclosedInput(),
  baseline: snapshot('2026-03-31', before),
  current: snapshot('2026-06-30', after),
});

describe('supplied disclosed holdings', () => {
  it.each([0, 6, 18])('echoes a detached, structured policy at precision %s', (precision) => {
    const input = disclosedInput();
    input.policy.ratioDecimalPlaces = precision;
    const report = compareDisclosedHoldings(input);
    expect(report.assumptions.policy).toEqual(input.policy);
    expect(report.assumptions.policy).not.toBe(input.policy);
    expect(report.assumptions.rounding).toContain(`to ${precision} decimal places`);
    input.policy.ratioDecimalPlaces = precision === 0 ? 18 : 0;
    expect(report.assumptions.policy.ratioDecimalPlaces).toBe(precision);
    report.assumptions.policy.ratioDecimalPlaces = 9;
    expect(input.policy.ratioDecimalPlaces).not.toBe(9);
  });

  it('separates typed library reason codes from original caller review text', () => {
    const input = disclosedInput();
    input.baseline.reviewReasons = ['Awaiting provider correction'];
    input.current.holdings[0]!.reviewReasons = ['Ambiguous share class in source'];
    const report = compareDisclosedHoldings(input);
    expect(report.baseline.reviewReasons).toEqual(['Awaiting provider correction']);
    expect(report.current.holdings[0]!.reviewReasons).toEqual(['Ambiguous share class in source']);
    expect(report.current.holdings[0]!.reasons).toEqual(['source_row_review']);
    expect(report.changes[0]!.reasons).toEqual([
      'baseline_source_snapshot_review',
      'current_holdings_require_review',
      'source_row_review',
    ]);
  });

  it('uses one root/domain/granular calculation with hand-computed changes and concentration', () => {
    const input = inputWith(
      [holding('A', '10', '100'), holding('B', '20', '300')],
      [holding('A', '12', '150'), holding('C', '7', '450')],
    );
    const result = compareDisclosedHoldings(input);
    expect(granular(input)).toEqual(result);
    expect(
      result.changes.map((row) => [
        row.classification,
        row.quantityDifference,
        row.valueDifference,
      ]),
    ).toEqual([
      ['still_disclosed', '2', '50'],
      ['no_longer_disclosed', '-20', '-300'],
      ['newly_disclosed', '7', '450'],
    ]);
    expect(result.current.concentration).toEqual({
      status: 'available',
      denominatorReportedValue: '600',
      valueCurrency: 'USD',
      largestWeight: '0.75',
      herfindahlIndex: '0.625',
      reasons: [],
    });
    expect(result.current.positions.map((row) => row.weight)).toEqual(['0.25', '0.75']);
    expect(result.diagnostics.status).toBe('complete');
    const artifact = createAnalysisArtifact({
      artifactType: 'portfolio.disclosed-holdings',
      producedBy: { operation: 'compareDisclosedHoldings' },
      inputs: { parameters: input },
      result,
    });
    expect(
      readAnalysisArtifact({ artifact: fromCanonicalJson(canonicalJsonOf(artifact)) }).artifact,
    ).toEqual(artifact);
  });

  it('retains exact huge and fractional quantities and normalizes mixed source scales in TypeScript', () => {
    const baseline = holding('A', '900719925474099300000.000000000000000001', '1.25000');
    baseline.valueScale = '1000';
    const current = holding(
      'A',
      '900719925474099300000.000000000000000003',
      '1250.000000000000000005',
    );
    const report = compareDisclosedHoldings(inputWith([baseline], [current]));
    expect(report.baseline.holdings[0]!.reportedValue).toBe('1.25000');
    expect(report.baseline.holdings[0]!.normalizedReportedValue).toBe('1250');
    expect(report.changes[0]!.quantityDifference).toBe('0.000000000000000002');
    expect(report.changes[0]!.valueDifference).toBe('0.000000000000000005');
    expect(report.current.positions[0]!.weight).toBe('1');
  });

  it('compares explicit same-period revisions without inferring trades', () => {
    const input = disclosedInput();
    input.comparisonMode = 'same-period-revision';
    input.current.periodEnd = input.baseline.periodEnd;
    const report = compareDisclosedHoldings(input);
    expect(report.comparisonMode).toBe('same-period-revision');
    expect(report.changes[0]!.quantityDifference).toBe('2');
    expect(report.assumptions.changes).toContain('not purchases/sales');
  });

  it.each(['reportComplete', 'mappingComplete', 'comparisonEligible'] as const)(
    'withholds absence, deltas and denominators for %s false',
    (flag) => {
      const input = inputWith([holding('A')], [holding('B')]);
      input.baseline[flag] = false;
      const report = compareDisclosedHoldings(input);
      expect(
        report.changes.every(
          (row) =>
            row.classification === 'unknown' &&
            row.quantityDifference === null &&
            row.valueDifference === null,
        ),
      ).toBe(true);
      expect(report.baseline.concentration.denominatorReportedValue).toBeNull();
      expect(report.baseline.holdings).toHaveLength(1);
      expect(report.baseline.positions[0]!.quantity).toBe('10');
    },
  );

  it('keeps matched observations still disclosed even when totals cannot establish a difference', () => {
    const input = disclosedInput();
    input.current.reportComplete = false;
    const row = compareDisclosedHoldings(input).changes[0]!;
    expect(row.classification).toBe('still_disclosed');
    expect(row.quantityDifference).toBeNull();
    expect(row.currentQuantity).toBe('12');
  });

  it.each([
    ['instrumentType', 'bond', 'unsupported_instrument_type'],
    ['quantityUnit', 'PRN', 'unsupported_quantity_unit'],
    ['putCall', 'put', 'option_position'],
    ['putCall', 'call', 'option_position'],
    ['investmentDiscretion', 'SHARED', 'unsupported_discretion'],
    ['otherManagerIds', ['filing-local-manager-2'], 'unsupported_discretion'],
    ['mappingStatus', 'unresolved', 'unresolved_identity'],
    ['issuerId', null, 'unresolved_identity'],
    ['reviewReasons', ['confidential holding'], 'source_row_review'],
  ])(
    'retains incompatible %s in the report and never silently filters the denominator',
    (key, value, reason) => {
      const input = disclosedInput();
      input.current.holdings = [{ ...holding(), [key as string]: value }];
      const result = compareDisclosedHoldings(input);
      expect(result.current.holdings).toHaveLength(1);
      expect(result.current.holdings[0]!.reasons).toContain(reason);
      expect(result.current.concentration.denominatorReportedValue).toBeNull();
      expect(result.changes[0]!.quantityDifference).toBeNull();
    },
  );

  it('preserves confidential report reviews and marks internally conflicting identities', () => {
    const input = disclosedInput();
    input.current.reviewReasons = ['confidential-treatment'];
    expect(compareDisclosedHoldings(input).current.concentration.reasons).toContain(
      'source_snapshot_review',
    );
    const a = holding();
    const b = {
      ...holding(),
      holdingId: 'second',
      issuerId: 'different-issuer',
      classId: 'different-class',
    };
    const report = compareDisclosedHoldings(inputWith([a], [a, b]));
    expect(report.current.positions.every((row) => row.status === 'review')).toBe(true);
    expect(
      report.current.holdings.every((row) => row.reasons.includes('conflicting_security_identity')),
    ).toBe(true);
    const duplicate = compareDisclosedHoldings(inputWith([a], [a, { ...b, classId: a.classId }]));
    expect(duplicate.current.positions[0]!.issuerId).toBeNull();
  });

  it('retains unknown mapping details without inventing a position identity', () => {
    const row = holding();
    row.securityId = null;
    row.classId = null;
    row.mappingStatus = 'unresolved';
    row.reviewReasons = ['out_of_date_reference'];
    const result = compareDisclosedHoldings(inputWith([], [row]));
    expect(result.current.holdings[0]!.reviewReasons).toEqual(['out_of_date_reference']);
    expect(result.current.positions).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.current.concentration.reasons).toContain('holdings_require_review');
  });

  it('withholds duplicated positions rather than guessing separate or overlapping discretion', () => {
    const first = holding();
    const second = { ...first, holdingId: 'different-row', quantity: '999' };
    const result = compareDisclosedHoldings(inputWith([first], [first, second]));
    expect(result.current.holdings).toHaveLength(2);
    expect(result.current.positions[0]!.holdingIds).toEqual(['different-row', 'holding-A']);
    expect(result.current.positions[0]!.quantity).toBeNull();
    expect(result.changes[0]!.classification).toBe('unknown');
  });

  it('keeps separate classes and reviews contradictory identities without conversion assumptions', () => {
    const first = holding('A');
    const second = holding('B');
    second.issuerId = first.issuerId;
    const result = compareDisclosedHoldings(inputWith([first, second], [first, second]));
    expect(result.current.positions).toHaveLength(2);
    expect(result.diagnostics.status).toBe('complete');
    const changed = { ...first, classId: 'different-class' };
    const conflict = compareDisclosedHoldings(inputWith([first], [changed]));
    expect(conflict.changes).toHaveLength(2);
    expect(
      conflict.changes.every(
        (row) =>
          row.classification === 'unknown' && row.reasons.includes('conflicting_security_identity'),
      ),
    ).toBe(true);
  });

  it('withholds snapshot totals for mixed currencies and value changes across currency changes', () => {
    const euro = holding('B');
    euro.valueCurrency = 'EUR';
    const mixed = compareDisclosedHoldings(inputWith([holding('A')], [holding('A'), euro]));
    expect(mixed.current.concentration.reasons).toContain('mixed_currencies');
    const current = holding();
    current.valueCurrency = 'EUR';
    const changed = compareDisclosedHoldings(inputWith([holding()], [current])).changes[0]!;
    expect(changed.valueDifference).toBeNull();
    expect(changed.quantityDifference).toBe('0');
    expect(changed.reasons).toContain('currency_mismatch');
  });

  it('preserves complete empty/zero disclosure absence and never divides by zero', () => {
    const added = compareDisclosedHoldings(inputWith([], [holding('A', '0', '0')]));
    expect(added.baseline.concentration.denominatorReportedValue).toBe('0');
    expect(added.current.concentration.herfindahlIndex).toBeNull();
    expect(added.changes[0]!.classification).toBe('newly_disclosed');
    expect(added.changes[0]!.quantityDifference).toBe('0');
    const removed = compareDisclosedHoldings(inputWith([holding('A', '0', '0')], []));
    expect(removed.changes[0]!.classification).toBe('no_longer_disclosed');
    const still = compareDisclosedHoldings(
      inputWith([holding('A', '0', '0')], [holding('A', '0', '0')]),
    );
    expect(still.changes[0]!.classification).toBe('still_disclosed');
  });

  it('normalizes input ordering without mutation and ignores harmless decoration', () => {
    const original = inputWith([holding('A'), holding('B')], [holding('A'), holding('C')]);
    const before = JSON.stringify(original);
    const expected = compareDisclosedHoldings(original);
    const permuted = structuredClone(original);
    permuted.baseline.holdings = [...permuted.baseline.holdings].reverse();
    permuted.current.holdings = [...permuted.current.holdings].reverse();
    permuted.current['providerDecoration'] = { arbitrary: new Date() };
    Object.defineProperty(permuted.current.holdings[0], 'ignored', {
      get() {
        throw new Error('decoration accessed');
      },
    });
    expect(compareDisclosedHoldings(permuted)).toEqual(expected);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('orders opaque non-BMP identifiers by Unicode code point, matching cross-language artifacts', () => {
    const first = holding('\u{10000}');
    const second = holding('\uE000');
    const result = compareDisclosedHoldings(inputWith([first, second], [first, second]));
    expect(result.current.holdings.map((row) => row.holdingId)).toEqual([
      'holding-\uE000',
      'holding-\u{10000}',
    ]);
  });

  it('matches an independent integer rational oracle over 125 exact concentration cases', () => {
    for (let a = 1; a <= 5; a++)
      for (let b = 1; b <= 5; b++)
        for (let c = 0; c <= 4; c++) {
          const report = compareDisclosedHoldings(
            inputWith(
              [holding()],
              [
                holding('A', '1', String(a)),
                holding('B', '1', String(b)),
                holding('C', '1', String(c)),
              ],
            ),
          );
          const round = (numerator: number, denominator: number) => {
            const scaled = BigInt(numerator) * 1000000000000n;
            const quotient = (scaled * 2n + BigInt(denominator)) / (2n * BigInt(denominator));
            return `${quotient / 1000000000000n}.${(quotient % 1000000000000n).toString().padStart(12, '0')}`.replace(
              /\.?0+$/,
              '',
            );
          };
          expect(report.current.concentration.herfindahlIndex).toBe(
            round(a * a + b * b + c * c, (a + b + c) ** 2),
          );
          expect(report.current.concentration.largestWeight).toBe(
            round(Math.max(a, b, c), a + b + c),
          );
        }
  });

  it('rounds exact half ties away from zero without rounding operands first', () => {
    const input = inputWith([holding()], [holding('A', '1', '1'), holding('B', '1', '7')]);
    input.policy.ratioDecimalPlaces = 2;
    const report = compareDisclosedHoldings(input);
    expect(report.current.positions.map((row) => row.weight)).toEqual(['0.13', '0.88']);
    expect(report.current.concentration.herfindahlIndex).toBe('0.78');
    input.policy.ratioDecimalPlaces = 0;
    expect(compareDisclosedHoldings(input).current.concentration.largestWeight).toBe('1');
  });
});
