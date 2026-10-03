import { ErrorCode, InputError, isoDateToEpochMs, requireArgumentObject } from '@totalfinance/core';
import type {
  DisclosedHoldingResult,
  DisclosedHoldingsSnapshotReport,
} from './disclosed-holdings-types.js';
import { decimal, decimalText } from './disclosed-holdings-decimal.js';

const FUNCTION = 'compareDisclosedHoldings';
export function compareText(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  while (true) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}
export const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

export function fail(
  path: string,
  message: string,
  code: string = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${FUNCTION}: ${path} ${message}`, {
    code,
    context: { function: FUNCTION, field: path },
  });
}

export function object(value: unknown, path: string): Record<string, unknown> {
  requireArgumentObject(FUNCTION, path, value);
  return value as Record<string, unknown>;
}

export function own(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || ('value' in descriptor && descriptor.value === undefined)) {
    return fail(`${path}.${key}`, 'is required.', ErrorCode.InputMissingField);
  }
  if (!('value' in descriptor))
    return fail(`${path}.${key}`, 'must be an own data property, not an accessor.');
  return descriptor.value;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail(path, 'must be a nonblank string.');
  if (value.length > 512 || value.trim().length === 0)
    return fail(path, 'must contain 1–512 nonblank characters.', ErrorCode.InputOutOfRange);
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

export function enumeration<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string') return fail(path, `must be one of ${allowed.join(', ')}.`);
  if (!(allowed as readonly string[]).includes(value))
    return fail(path, `must be one of ${allowed.join(', ')}.`, ErrorCode.InputInvalidEnum);
  return value as T;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'must be an explicit boolean.');
  return value;
}

export function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, 'must be a dense array.');
  if (value.length > maximum)
    return fail(path, `exceeds the ${maximum}-item bound.`, ErrorCode.InputOutOfRange);
  return value;
}

export function list(value: unknown, path: string, maximum: number, nonempty = false): string[] {
  const rows = array(value, path, maximum);
  if (nonempty && rows.length === 0)
    return fail(path, 'must not be empty.', ErrorCode.InputOutOfRange);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const item = text(own(rows, String(index), path), `${path}[${index}]`);
    if (seen.has(item))
      return fail(`${path}[${index}]`, 'duplicates a list identity.', ErrorCode.InputOutOfRange);
    seen.add(item);
    result.push(item);
  }
  return result.sort(compareText);
}

function amount(value: unknown, path: string): string {
  if (typeof value !== 'string')
    return fail(path, 'must be an exact nonnegative decimal string, never a number.');
  if (value.length > 101 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    return fail(
      path,
      'must be plain nonnegative base-ten without exponent/sign/leading zeros, at most 100 digits.',
      ErrorCode.InputOutOfRange,
    );
  const parts = value.split('.');
  if ((parts[1]?.length ?? 0) > 18 || value.replace('.', '').length > 100)
    return fail(
      path,
      'must have at most 100 digits and 18 fractional places.',
      ErrorCode.InputOutOfRange,
    );
  return value;
}

function holding(value: unknown, path: string): DisclosedHoldingResult {
  const row = object(value, path);
  const field = (key: string): unknown => own(row, key, path);
  const quantity = amount(field('quantity'), `${path}.quantity`);
  const reportedValue = amount(field('reportedValue'), `${path}.reportedValue`);
  const valueScale = enumeration(field('valueScale'), `${path}.valueScale`, ['1', '1000']);
  const valueCurrency = text(field('valueCurrency'), `${path}.valueCurrency`);
  if (!/^[A-Z]{3}$/.test(valueCurrency))
    fail(
      `${path}.valueCurrency`,
      'must be an uppercase three-letter currency code.',
      ErrorCode.InputOutOfRange,
    );
  const parsed = decimal(reportedValue);
  return {
    holdingId: text(field('holdingId'), `${path}.holdingId`),
    issuerId: nullableText(field('issuerId'), `${path}.issuerId`),
    securityId: nullableText(field('securityId'), `${path}.securityId`),
    classId: nullableText(field('classId'), `${path}.classId`),
    mappingStatus: enumeration(field('mappingStatus'), `${path}.mappingStatus`, [
      'mapped',
      'unresolved',
    ]),
    instrumentType: text(field('instrumentType'), `${path}.instrumentType`),
    quantity,
    quantityUnit: text(field('quantityUnit'), `${path}.quantityUnit`),
    reportedValue,
    valueCurrency,
    valueScale,
    putCall: enumeration(field('putCall'), `${path}.putCall`, ['none', 'put', 'call']),
    investmentDiscretion: text(field('investmentDiscretion'), `${path}.investmentDiscretion`),
    otherManagerIds: list(field('otherManagerIds'), `${path}.otherManagerIds`, 64),
    evidenceIds: list(field('evidenceIds'), `${path}.evidenceIds`, 64, true),
    reviewReasons: list(field('reviewReasons'), `${path}.reviewReasons`, 64),
    normalizedReportedValue: decimalText({
      ...parsed,
      coefficient: parsed.coefficient * BigInt(valueScale),
    }),
    status: 'supported',
    reasons: [],
  };
}

export function snapshot(value: unknown, path: string): DisclosedHoldingsSnapshotReport {
  const record = object(value, path);
  const field = (key: string): unknown => own(record, key, path);
  const rows = array(field('holdings'), `${path}.holdings`, 25_000);
  const periodEnd = text(field('periodEnd'), `${path}.periodEnd`);
  try {
    isoDateToEpochMs(periodEnd);
  } catch {
    fail(
      `${path}.periodEnd`,
      'must be a real YYYY-MM-DD calendar date.',
      ErrorCode.InputOutOfRange,
    );
  }
  const result: DisclosedHoldingsSnapshotReport = {
    managerId: text(field('managerId'), `${path}.managerId`),
    periodEnd,
    reportIds: list(field('reportIds'), `${path}.reportIds`, 256, true),
    evidenceIds: list(field('evidenceIds'), `${path}.evidenceIds`, 256, true),
    reportComplete: boolean(field('reportComplete'), `${path}.reportComplete`),
    mappingComplete: boolean(field('mappingComplete'), `${path}.mappingComplete`),
    comparisonEligible: boolean(field('comparisonEligible'), `${path}.comparisonEligible`),
    reviewReasons: list(field('reviewReasons'), `${path}.reviewReasons`, 256),
    holdings: [],
    positions: [],
    concentration: {
      status: 'review',
      denominatorReportedValue: null,
      valueCurrency: null,
      largestWeight: null,
      herfindahlIndex: null,
      reasons: [],
    },
  };
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = holding(own(rows, String(index), `${path}.holdings`), `${path}.holdings[${index}]`);
    if (seen.has(row.holdingId))
      fail(
        `${path}.holdings[${index}].holdingId`,
        'duplicates a holding identity.',
        ErrorCode.InputOutOfRange,
      );
    seen.add(row.holdingId);
    result.holdings.push(row);
  }
  result.holdings.sort((left, right) => compareText(left.holdingId, right.holdingId));
  return result;
}
