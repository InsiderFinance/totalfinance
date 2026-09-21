/**
 * Internal helpers shared across the portfolio modules. Nothing here is public API — the public
 * surface is curated by `index.ts` and the subpath entrypoints (`events.ts`, `ledger.ts`,
 * `performance.ts`).
 */

import { ErrorCode, InputError, DataError, requireArgumentObject } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';

/** Describe an untrusted boundary value without invoking coercion, getters, or `toJSON`. */
export function describeInputValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}

// ---------------------------------------------------------------------------------------------------
// Currency codes and the FC5 currency-pair vocabulary (structural reuse)
// ---------------------------------------------------------------------------------------------------

/**
 * One spot exchange-rate quote — `@totalfinance/foreign-exchange`'s (FC5) `CurrencyPairQuote`
 * vocabulary, reused STRUCTURALLY because the FC0 dependency row for `@totalfinance/portfolio`
 * (`tools/package-graph.test.ts`) allows only core and performance as runtime edges. The fields,
 * semantics, and conversion arithmetic (direct = multiply by `quotePerBase`, inverted = divide)
 * are identical to FC5's, and the parity test in
 * `test/snapshot.test.ts` proves both compile-time mutual assignability and runtime equality with
 * `convertCurrency` — the Gate B precedent of a grammar defined below its owner staying
 * structurally identical (core ↔ risk `Shock`).
 */
export interface CurrencyPairQuote {
  /** Uppercase three-letter ISO-style code of the currency being priced (ONE unit of this). */
  baseCurrency: string;
  /** Uppercase three-letter ISO-style code of the currency the price is expressed in. */
  quoteCurrency: string;
  /** Units of quote currency per ONE base unit; must be finite and > 0. */
  quotePerBase: number;
}

const CURRENCY_PAIR_QUOTE_KEYS = ['baseCurrency', 'quoteCurrency', 'quotePerBase'] as const;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Validate one currency-code field: an uppercase three-letter ISO-style string. */
export function requireCurrencyCode(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new InputError(
      `${functionName}: ${field} must be an uppercase three-letter currency code string (e.g. 'USD'). Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
  if (!CURRENCY_CODE_PATTERN.test(value)) {
    const uppercased = value.toUpperCase();
    const fix = CURRENCY_CODE_PATTERN.test(uppercased) ? ` — write it as '${uppercased}'` : '';
    throw new InputError(
      `${functionName}: ${field} must be an uppercase three-letter ISO-style currency code matching /^[A-Z]{3}$/ (e.g. 'USD'). Received ${JSON.stringify(value)}${fix}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, value } },
    );
  }
}

/** Validate a {@link CurrencyPairQuote}: known keys, two distinct codes, finite positive rate. */
export function requireCurrencyPairQuoteShape(
  functionName: string,
  label: string,
  quote: unknown,
): asserts quote is CurrencyPairQuote {
  requireArgumentObject(functionName, label, quote);
  const record = quote as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CURRENCY_PAIR_QUOTE_KEYS as readonly string[]).includes(key)) {
      throw new InputError(
        `${functionName}: ${label}.${key} is not a CurrencyPairQuote field — a quote is exactly { baseCurrency, quoteCurrency, quotePerBase }.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: `${label}.${key}` },
        },
      );
    }
  }
  requireCurrencyCode(functionName, `${label}.baseCurrency`, record['baseCurrency']);
  requireCurrencyCode(functionName, `${label}.quoteCurrency`, record['quoteCurrency']);
  const quotePerBase = record['quotePerBase'];
  if (typeof quotePerBase !== 'number' || !Number.isFinite(quotePerBase) || quotePerBase <= 0) {
    throw new InputError(
      `${functionName}: ${label}.quotePerBase must be a finite number > 0 — it prices ONE unit of ${String(record['baseCurrency'])} in ${String(record['quoteCurrency'])}. Received ${typeof quotePerBase === 'number' ? quotePerBase : quotePerBase === null ? 'null' : typeof quotePerBase}.`,
      {
        code:
          typeof quotePerBase === 'number' && Number.isFinite(quotePerBase)
            ? ErrorCode.InputOutOfRange
            : ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.quotePerBase` },
      },
    );
  }
  if (record['baseCurrency'] === record['quoteCurrency']) {
    throw new InputError(
      `${functionName}: ${label} prices ${String(record['baseCurrency'])} in itself — baseCurrency and quoteCurrency must differ. A same-currency "pair" carries no exchange-rate information; drop the quote instead.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: label } },
    );
  }
}

/**
 * Convert `amount` of `fromCurrency` into `toCurrency` using exactly ONE of the supplied quotes,
 * in either orientation — FC5's `convertCurrency` arithmetic verbatim (direct: multiply by
 * `quotePerBase`; inverted: divide). Zero connecting quotes is a typed unavailable-mark failure;
 * two or more is an ambiguity refusal (a deterministic valuation cannot pick one silently).
 */
export function convertWithQuotes(input: {
  functionName: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  quotes: readonly CurrencyPairQuote[];
  /** Prose naming what is being valued — used in the teaching error. */
  subject: string;
}): { convertedAmount: number; quoteUsed: CurrencyPairQuote; orientation: 'direct' | 'inverted' } {
  const { functionName, amount, fromCurrency, toCurrency, quotes, subject } = input;
  const connecting = quotes.filter(
    (quote) =>
      (quote.baseCurrency === fromCurrency && quote.quoteCurrency === toCurrency) ||
      (quote.baseCurrency === toCurrency && quote.quoteCurrency === fromCurrency),
  );
  if (connecting.length === 0) {
    throw new DataError(
      `${functionName}: no currencyConversions quote connects ${fromCurrency} to ${toCurrency}, needed to value ${subject} in the base currency. Supply a quote for the pair in either orientation.\n  e.g. currencyConversions: [{ baseCurrency: '${fromCurrency}', quoteCurrency: '${toCurrency}', quotePerBase: 1.08 }]`,
      {
        code: ErrorCode.PortfolioMarkUnavailable,
        context: { function: functionName, fromCurrency, toCurrency },
      },
    );
  }
  if (connecting.length > 1) {
    throw new InputError(
      `${functionName}: ${connecting.length} currencyConversions quotes connect ${fromCurrency} and ${toCurrency} — a deterministic valuation cannot choose between them. Supply exactly one quote per currency pair.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          fromCurrency,
          toCurrency,
          quoteCount: connecting.length,
        },
      },
    );
  }
  const quoteUsed = connecting[0]!;
  const orientation: 'direct' | 'inverted' =
    quoteUsed.baseCurrency === fromCurrency ? 'direct' : 'inverted';
  const convertedAmount =
    orientation === 'direct' ? amount * quoteUsed.quotePerBase : amount / quoteUsed.quotePerBase;
  return { convertedAmount, quoteUsed, orientation };
}

// ---------------------------------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------------------------------

const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Read an own property from a string-keyed dictionary. Portfolio identities are deliberately open
 * strings, so names such as `constructor` and `__proto__` are valid identifiers rather than
 * invitations to walk `Object.prototype`.
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** True only when `key` is an own property of `record`. */
export function hasOwnKey(record: object, key: PropertyKey): boolean {
  return hasOwnProperty.call(record, key);
}

/**
 * Require a plain JSON object whose own members are enumerable stored data. This rejects class
 * instances, accessors, hidden fields, and symbols before a public economic boundary can observe
 * behavior that canonical JSON would not hash or persist.
 */
export function requirePlainDataObject(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  requireArgumentObject(functionName, label, value);
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError(
      `${functionName}: ${label} must be a plain JSON object, not a class instance or custom-prototype object.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
    );
  }
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        `${functionName}: ${label} must contain only enumerable string-keyed stored data — accessors, hidden fields, and symbols cannot define economic input.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
      );
    }
  }
}

/** Reject a consumed field inherited from a polluted prototype instead of reading it as input. */
export function requireNoInheritedFields(
  functionName: string,
  label: string,
  record: object,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (hasOwnKey(record, field) || !(field in record)) continue;
    throw new InputError(
      `${functionName}: ${label}.${field} is inherited rather than an own JSON field — economic inputs must be represented by the bytes that are hashed and stored.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, field: `${label}.${field}` },
      },
    );
  }
}

/** Dense plain JSON array validation for economic lists. */
export function requireDenseDataArray(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${label} must be an array. Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
    );
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputError(`${functionName}: ${label} must be a plain JSON array.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: label },
    });
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(
        `${functionName}: ${label} must be a dense array of stored data; index ${index} is missing or is an accessor.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field: `${label}[${index}]` },
        },
      );
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new InputError(
        `${functionName}: ${label} must contain only dense array indices; ${String(key)} is not JSON array data.`,
        { code: ErrorCode.InputWrongShape, context: { function: functionName, field: label } },
      );
    }
  }
}

/**
 * Define one enumerable own dictionary property without invoking the legacy `__proto__` setter.
 * The result remains a normal JSON-safe `Record`, including after stringify/parse round trips.
 */
export function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Human-readable, collision-free label for an `(accountId, instrumentId)` pair. Ordinary ids keep
 * the familiar `account/instrument` spelling; JSON escapes plus an escaped separator preserve the
 * boundary when either open identity itself contains `/`, `\\`, control characters, or surrogates.
 */
export function positionGroupingLabel(accountId: string, instrumentId: string): string {
  const escape = (value: string): string =>
    JSON.stringify(value).slice(1, -1).replaceAll('/', '\\/');
  return `${escape(accountId)}/${escape(instrumentId)}`;
}

/** Validate a non-empty-string identity field (eventId, sourceId, accountId, instrumentId, …). */
export function requireIdentityString(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-empty string. Received ${value === null ? 'null' : typeof value === 'string' ? "''" : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

/** Validate a finite number field, with the standard teaching. */
export function requireFiniteNumberField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite number. Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      {
        code: typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
}

/** Validate a finite number field that must be strictly positive. */
export function requirePositiveNumberField(
  functionName: string,
  field: string,
  value: unknown,
  meaning: string,
): asserts value is number {
  requireFiniteNumberField(functionName, field, value);
  if ((value as number) <= 0) {
    throw new InputError(
      `${functionName}: ${field} must be > 0 — ${meaning}. Received ${value as number}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
}

const PROVENANCE_KEYS = [
  'provider',
  'dataset',
  'asOf',
  'receivedAt',
  'sourceVersion',
  'requestId',
  'warnings',
] as const;
const PROVENANCE_WARNING_KEYS = ['code', 'message', 'severity', 'context'] as const;
const PROVENANCE_WARNING_SEVERITIES = ['info', 'warn', 'error'] as const;

/** Validate a caller-supplied `Provenance` record (closed keys, typed fields — the
 * market-snapshot precedent). */
export function requireProvenanceShape(functionName: string, label: string, value: unknown): void {
  requirePlainDataObject(functionName, label, value);
  const record = value as Record<string, unknown>;
  requireNoInheritedFields(functionName, label, record, PROVENANCE_KEYS);
  for (const key of Object.keys(record)) {
    if (!(PROVENANCE_KEYS as readonly string[]).includes(key)) {
      throw new InputError(
        `${functionName}: ${label}.${key} is not a Provenance field — provenance is exactly { provider?, dataset?, asOf?, receivedAt?, sourceVersion?, requestId?, warnings? }.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: `${label}.${key}` },
        },
      );
    }
  }
  for (const field of ['provider', 'dataset', 'sourceVersion', 'requestId'] as const) {
    const member = record[field];
    if (member !== undefined && typeof member !== 'string') {
      throw new InputError(
        `${functionName}: ${label}.${field} must be a string when present. Received ${member === null ? 'null' : typeof member}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.${field}` },
        },
      );
    }
  }
  for (const field of ['asOf', 'receivedAt'] as const) {
    const member = record[field];
    if (member !== undefined && (typeof member !== 'number' || !Number.isFinite(member))) {
      throw new InputError(
        `${functionName}: ${label}.${field} must be a finite epoch-milliseconds number when present. Received ${member === null ? 'null' : typeof member === 'number' ? member : typeof member}.`,
        {
          code: typeof member === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.${field}` },
        },
      );
    }
  }
  if (record['warnings'] !== undefined) {
    requireDenseDataArray(functionName, `${label}.warnings`, record['warnings']);
    for (let index = 0; index < record['warnings'].length; index++) {
      const path = `${label}.warnings[${index}]`;
      const raw = record['warnings'][index];
      requirePlainDataObject(functionName, path, raw);
      requireNoInheritedFields(functionName, path, raw, PROVENANCE_WARNING_KEYS);
      for (const key of Object.keys(raw)) {
        if (!(PROVENANCE_WARNING_KEYS as readonly string[]).includes(key)) {
          throw new InputError(
            `${functionName}: ${path}.${key} is not a QuantWarning field — a provenance warning is exactly { code, message, severity, context? }.`,
            {
              code: ErrorCode.InputUnknownField,
              context: { function: functionName, field: `${path}.${key}` },
            },
          );
        }
      }
      const code = raw['code'];
      if (typeof code !== 'string' || code.length === 0) {
        throw new InputError(
          `${functionName}: ${path}.code must be a non-empty warning-code string.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: `${path}.code` },
          },
        );
      }
      const message = raw['message'];
      if (typeof message !== 'string') {
        throw new InputError(
          `${functionName}: ${path}.message must be a string. Received ${message === null ? 'null' : typeof message}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: `${path}.message` },
          },
        );
      }
      const severity = raw['severity'];
      if (!(PROVENANCE_WARNING_SEVERITIES as readonly unknown[]).includes(severity)) {
        const received = describeInputValue(severity);
        throw new InputError(
          `${functionName}: ${path}.severity must be 'info', 'warn', or 'error'. Received ${received}.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: { function: functionName, field: `${path}.severity`, received },
          },
        );
      }
      if (raw['context'] !== undefined) {
        requirePlainDataObject(functionName, `${path}.context`, raw['context']);
      }
    }
  }

  // The reducer snapshots input through this exact serializer before folding. Validate that full
  // recursive grammar here too, so an envelope accepted by validation/contentHash cannot later
  // fail merely because provenance contains a sparse nested array, accessor, symbol, or class.
  try {
    canonicalJsonOf(record);
  } catch (error) {
    if (error instanceof InputError) {
      throw new InputError(
        `${functionName}: ${label} must be recursively canonical JSON data. ${error.message}`,
        {
          code: error.code,
          context: { ...(error.context ?? {}), function: functionName, field: label },
        },
      );
    }
    throw error;
  }
}

/** UTC calendar date (`YYYY-MM-DD`) of an epoch-milliseconds instant. Deterministic, clock-free. */
export function epochMsToUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Recursively freeze a plain JSON tree in place and return it (mirror of core's internal). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** Quantities/amounts closer to zero than this are floating-point dust from exact relief. */
export const QUANTITY_DUST = 1e-9;

/** The instants ECMAScript `Date` can represent: ±8.64e15 ms around the epoch (±100M days). */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * An epoch-millisecond timestamp: finite, an integer (no fractional milliseconds — the fold orders
 * events by this number and the seam turns it into a calendar date), and inside the range `Date`
 * represents. Outside it, `new Date(ms).toISOString()` throws a raw RangeError — the magnitude
 * mutant reached exactly that through a tampered ledger (2026-08-28), so the law lives here, shared by
 * the envelope door and every as-of instant a report turns into a date.
 */
export function requireEpochMsField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  requireFiniteNumberField(functionName, field, value);
  const ms = value as number;
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
    throw new InputError(
      `${functionName}: ${field} must be an integer epoch-millisecond timestamp within ±8.64e15 (the instants a Date can represent, about ±273,000 years). Received ${String(ms)}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
}
