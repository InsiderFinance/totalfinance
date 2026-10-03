import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import { compareDisclosedHoldings } from '@totalfinance/portfolio/disclosed-holdings';
import {
  disclosedInput,
  disclosedHolding,
} from '../../../tools/first-touch/fixtures/disclosed-holdings.js';

const call = (input: unknown) => compareDisclosedHoldings(input as never);
const codeOf = (input: unknown) => {
  try {
    call(input);
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(InputError);
    return (error as InputError).code;
  }
};

describe('disclosed-holdings boundary', () => {
  it.each([undefined, null, [], 1, true, 'request'])('refuses non-request %j', (input) => {
    expect(codeOf(input)).toBe(ErrorCode.InputWrongType);
  });
  it('rejects unknown request and policy controls', () => {
    expect(codeOf({ ...disclosedInput(), typo: true })).toBe(ErrorCode.InputUnknownField);
    const input = disclosedInput();
    expect(codeOf({ ...input, policy: { ...input.policy, typo: true } })).toBe(
      ErrorCode.InputUnknownField,
    );
  });
  it.each(['baseline', 'current', 'comparisonMode', 'policy'])('requires %s', (key) => {
    const input = disclosedInput() as unknown as Record<string, unknown>;
    delete input[key];
    expect(codeOf(input)).toBe(ErrorCode.InputMissingField);
  });
  it.each([
    'managerId',
    'periodEnd',
    'reportIds',
    'evidenceIds',
    'reportComplete',
    'mappingComplete',
    'comparisonEligible',
    'reviewReasons',
    'holdings',
  ])('requires snapshot %s', (key) => {
    const input = disclosedInput();
    delete input.current[key];
    expect(codeOf(input)).toBe(ErrorCode.InputMissingField);
  });
  it.each(Object.keys(disclosedHolding()))('requires holding %s', (key) => {
    const input = disclosedInput();
    delete input.current.holdings[0]![key];
    expect(codeOf(input)).toBe(ErrorCode.InputMissingField);
  });
  it.each([
    '-1',
    '+1',
    '1e3',
    '01',
    '.1',
    '1.',
    ' 1',
    '1 ',
    'NaN',
    'Infinity',
    '0.0000000000000000001',
    '1'.repeat(101),
    1,
    null,
    true,
  ])('refuses invalid exact amount %j', (value) => {
    const input = disclosedInput();
    input.current.holdings[0]!.quantity = value as string;
    expect(() => call(input)).toThrow(InputError);
  });
  it.each(['0', '100', 1000, '1.0', null])('refuses value scale %j', (value) => {
    const input = disclosedInput();
    input.current.holdings[0]!.valueScale = value as never;
    expect(() => call(input)).toThrow(InputError);
  });
  it.each([-1, 19, 1.5, NaN, Infinity, '12', null])('refuses ratio precision %j', (value) => {
    const input = disclosedInput();
    input.policy.ratioDecimalPlaces = value as number;
    expect(() => call(input)).toThrow(InputError);
  });
  it.each(['2026-02-30', '2026-6-30', '2026-06-30T00:00:00Z', 'no-date'])(
    'refuses period %s',
    (date) => {
      const input = disclosedInput();
      input.current.periodEnd = date;
      expect(() => call(input)).toThrow(InputError);
    },
  );
  it('rejects distinct managers, backwards periods and fabricated revision comparisons', () => {
    const input = disclosedInput();
    input.current.managerId = 'other';
    expect(() => call(input)).toThrow(InputError);
    input.current.managerId = input.baseline.managerId;
    input.current.periodEnd = '2025-12-31';
    expect(() => call(input)).toThrow(InputError);
    input.comparisonMode = 'same-period-revision';
    expect(() => call(input)).toThrow(InputError);
    input.current.periodEnd = input.baseline.periodEnd;
    input.current.reportIds = [...input.baseline.reportIds];
    expect(() => call(input)).toThrow(InputError);
  });
  it('rejects duplicate holding/evidence identity, malformed flags, missing currency and invalid enums', () => {
    const input = disclosedInput();
    input.current.holdings = [disclosedHolding(), disclosedHolding()];
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings = [disclosedHolding()];
    input.current.evidenceIds = ['x', 'x'];
    expect(() => call(input)).toThrow(InputError);
    input.current.evidenceIds = ['x'];
    input.current.reportComplete = 1 as never;
    expect(() => call(input)).toThrow(InputError);
    input.current.reportComplete = true;
    input.current.holdings[0]!.valueCurrency = 'usd';
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings[0]!.valueCurrency = 'USD';
    input.current.holdings[0]!.mappingStatus = 'ambiguous' as never;
    expect(() => call(input)).toThrow(InputError);
  });
  it('refuses sparse arrays and consumed accessors without invoking them', () => {
    const input = disclosedInput();
    input.current.holdings = new Array(2);
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings = [disclosedHolding()];
    Object.defineProperty(input.current.holdings[0], 'quantity', {
      get() {
        throw new Error('accessor invoked');
      },
    });
    expect(() => call(input)).toThrow(InputError);
    const other = disclosedInput();
    Object.defineProperty(other.current.holdings, '0', {
      get() {
        throw new Error('accessor invoked');
      },
    });
    expect(() => call(other)).toThrow(InputError);
  });
  it('rejects empty evidence, malformed list rows, non-array rows and blank opaque IDs', () => {
    const input = disclosedInput();
    input.current.reportIds = [];
    expect(() => call(input)).toThrow(InputError);
    input.current.reportIds = ['report'];
    input.current.holdings[0]!.evidenceIds = [false as never];
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings[0]!.evidenceIds = ['source'];
    input.current.holdings = {} as never;
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings = [disclosedHolding()];
    input.current.holdings[0]!.issuerId = '  ';
    expect(() => call(input)).toThrow(InputError);
  });

  it('bounds work before walking oversized arrays or strings', () => {
    const input = disclosedInput();
    const rows = new Array(25_001);
    Object.defineProperty(rows, '0', {
      get() {
        throw new Error('walked oversized array');
      },
    });
    input.current.holdings = rows;
    expect(() => call(input)).toThrow(InputError);
    input.current.holdings = [disclosedHolding()];
    input.current.managerId = 'a'.repeat(513);
    expect(() => call(input)).toThrow(InputError);
    input.current.managerId = input.baseline.managerId;
    input.current.evidenceIds = new Array(257);
    expect(() => call(input)).toThrow(InputError);
  });
  it('accepts maximum decimal size, precision and literal-zero evidence', () => {
    const input = disclosedInput();
    input.current.holdings[0]!.quantity = '9'.repeat(100);
    input.policy.ratioDecimalPlaces = 18;
    expect(call(input).current.positions[0]!.quantity).toBe('9'.repeat(100));
    input.current.holdings[0]!.quantity = '0.000000000000000000';
    expect(call(input).current.positions[0]!.quantity).toBe('0');
  });
});
