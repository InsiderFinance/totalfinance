/**
 * Builder input guards (dx §1.3). Fixed-income specs are date-heavy: a missing `issueDate` used to
 * surface as `Invalid ISO date "undefined"` — typed, but it never said WHICH field was missing.
 * These guards run before any date parsing and name the field with a working example.
 */

import {
  ensureFiniteWhenPresent,
  ErrorCode,
  InputError,
  missingFieldError,
  wrongShapeError,
} from '@totalfinance/core';

/**
 * The whole runtime day-count domain, compiler-checked against the declared union — a missing or
 * misspelled member is a type error here, so the ladder cannot drift from the type it teaches.
 */
const DAY_COUNT_DOMAIN = ['ACT/365F', 'ACT/360', '30/360', 'ACT/ACT', '30E/360'] as const;

/** Named coupon frequencies; the union also admits an explicit payments-per-year number. */
const NAMED_FREQUENCIES = ['annual', 'semiannual', 'quarterly', 'bimonthly', 'monthly'] as const;

/** Generous semantic ceiling; each caller also applies its tighter tree/path-product cap. */
const MAX_STEPS_PER_YEAR = 1_000_000;

/**
 * Optional-convention ladders (the 350c2796 ruling): a PRESENT dayCount/frequency/flag must be a
 * member of its domain — null and truthy strings used to coalesce into the industry default and
 * silently change the accrual math.
 */
export function ensureDayCountWhenPresent(value: unknown, functionName: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !(DAY_COUNT_DOMAIN as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: dayCount must be one of ${DAY_COUNT_DOMAIN.join(' | ')} when provided — omit the field to use the documented default. Received ${value === null ? 'null' : typeof value === 'string' ? `"${value}"` : typeof value}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'dayCount', received: value },
      },
    );
  }
}

export function ensureFrequencyWhenPresent(value: unknown, functionName: string): void {
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return;
  if (typeof value === 'string' && (NAMED_FREQUENCIES as readonly string[]).includes(value)) return;
  throw new InputError(
    `${functionName}: frequency must be ${NAMED_FREQUENCIES.join(' | ')} or a positive number of payments per year when provided. Received ${value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value)}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { function: functionName, field: 'frequency', received: value },
    },
  );
}

/** A lattice resolution is a count, not a continuous frequency estimate. */
export function ensureStepsPerYearWhenPresent(value: unknown, functionName: string): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_STEPS_PER_YEAR
  ) {
    throw new InputError(
      `${functionName}: stepsPerYear must be a positive safe integer ≤ ${MAX_STEPS_PER_YEAR.toLocaleString('en-US')} (a lattice resolution count; the derived tree or paths×steps cap may be lower). Received ${String(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'stepsPerYear',
          received: value,
          max: MAX_STEPS_PER_YEAR,
        },
      },
    );
  }
}

export function ensureBooleanWhenPresent(
  value: unknown,
  functionName: string,
  field: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    throw new InputError(
      `${functionName}: ${field} must be a boolean when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field, received: value },
      },
    );
  }
}

/** Finite-number-when-present for a list of optional fields — one call per boundary. */
export function ensureFiniteFieldsWhenPresent(
  functionName: string,
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    ensureFiniteWhenPresent(value[field], field, functionName);
  }
}

/**
 * FIELD VALUES, assembled into a runnable call — not shown to the caller on their own.
 *
 * These were the whole example, so `bonds.fixedRate` answered a missing field with
 * `e.g. issueDate: '2026-01-15'` — a fragment, the exact shape RV2 replaced everywhere it could see.
 * It survived here because the gate built to catch it scanned `requireFiniteFields` and a literal
 * `missingFieldError` argument, and this emitter is a SHARED helper reached with a variable field.
 * A gate's blind spot is where the class it was built for keeps living.
 */
const FIELD_VALUES: Record<string, string> = {
  issueDate: "'2026-01-15'",
  maturityDate: "'2031-01-15'",
  couponRate: '0.05',
  frequency: '2',
  settlement: "'2026-07-06'",
  notional: '1_000_000',
  faceValue: '1000',
  settlementDate: "'2026-07-06'",
};

/** The units and conventions a call shape cannot carry. */
export const FIELD_HINTS: Record<string, string> = {
  couponRate: 'annualized decimal',
  frequency: 'coupons per year',
};

/** A complete, pasteable call to the function that threw, carrying every field it requires. */
export function specificationExampleCall(
  functionName: string,
  required: readonly string[],
): string {
  const body = required.map((f) => `${f}: ${FIELD_VALUES[f] ?? '…'}`).join(', ');
  return `${functionName}({ ${body} })`;
}

/**
 * Throw a teaching error unless `specification` is an object carrying every `required` field. The error
 * names the missing field (with an example) — or, when the whole specification is the wrong shape, echoes
 * the expected shape and the keys the caller actually passed.
 */
export function requireSpecification(
  functionName: string,
  specification: unknown,
  required: readonly string[],
): void {
  if (specification === null || typeof specification !== 'object') {
    throw wrongShapeError(functionName, `{ ${required.join(', ')}, … }`, specification);
  }
  const obj = specification as Record<string, unknown>;
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      throw missingFieldError(
        functionName,
        field,
        specificationExampleCall(functionName, required),
        FIELD_HINTS[field],
      );
    }
  }
}
