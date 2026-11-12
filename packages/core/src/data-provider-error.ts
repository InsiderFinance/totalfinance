/** Public safe provider error declaration; arbitrary messages and causes are local only. */
import {
  DataError,
  InputError,
  UnsupportedError,
  ConfigurationError,
  ErrorCode,
  QuantError,
} from './errors.js';
import { scanCanonicalData } from './artifacts/canonical-scan.js';
import { object, enumField, numberField, fail } from './data-validation.js';
export type KnownDataField =
  | 'request.symbol'
  | 'request.from'
  | 'request.to'
  | 'request.from/to'
  | 'request.limit'
  | 'request.interval';
export type DataGuidanceRule =
  | 'uppercase_symbol'
  | 'zoned_instant_required'
  | 'session_date_required'
  | 'ordered_bounds'
  | 'page_limit'
  | 'unsupported_interval'
  | 'source_domain_rule';
export interface DataProviderFailure {
  readonly version: 1;
  readonly code: string;
  readonly guidance?: { readonly field: KnownDataField; readonly rule: DataGuidanceRule };
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
}
export interface DataProviderErrorOptions extends Omit<DataProviderFailure, 'version'> {
  readonly cause?: unknown;
}
const fields = [
  'request.symbol',
  'request.from',
  'request.to',
  'request.from/to',
  'request.limit',
  'request.interval',
];
const teaching = {
  uppercase_symbol: 'requires uppercase provider symbols; for example SPY',
  zoned_instant_required: 'requires a zoned ISO instant',
  session_date_required: 'requires a YYYY-MM-DD session label',
  ordered_bounds: 'requires from <= to',
  page_limit: 'exceeds the permitted page size',
  unsupported_interval: 'is unsupported by this provider',
  source_domain_rule: 'was rejected by the provider domain rule',
};
const codes = new Set<string>([
  ErrorCode.DataUnsupportedCapability,
  ErrorCode.DataContractVersionUnsupported,
  ErrorCode.DataAuthenticationRequired,
  ErrorCode.DataEntitlementRequired,
  ErrorCode.DataRateLimited,
  ErrorCode.DataAllowanceExhausted,
  ErrorCode.DataSnapshotExpired,
  ErrorCode.DataInvalidCursor,
  ErrorCode.DataNotFound,
  ErrorCode.DataInvalidRequest,
  ErrorCode.DataInvalidResponse,
  ErrorCode.DataUnavailable,
  ErrorCode.DataAborted,
  ErrorCode.DataProviderFailure,
]);
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && 'value' in d ? d.value : undefined;
}
function safeFailure(value: unknown): DataProviderFailure {
  scanCanonicalData(value, {
    functionName: 'DataProviderError',
    label: 'dataFailure',
    requireFiniteNumbers: true,
    maximumWorkUnits: 1000,
  });
  const x = object(value, 'dataFailure', [
    'version',
    'code',
    'guidance',
    'retryable',
    'retryAfterMs',
    'status',
  ]);
  enumField(x['version'], 'dataFailure.version', [1]);
  if (!codes.has(x['code'] as string)) fail('dataFailure.code', ErrorCode.InputInvalidEnum);
  if (x['guidance'] !== undefined) {
    const g = object(x['guidance'], 'guidance', ['field', 'rule']);
    enumField(g['field'], 'guidance.field', fields);
    enumField(g['rule'], 'guidance.rule', Object.keys(teaching));
  }
  if (x['retryable'] !== undefined) enumField(x['retryable'], 'retryable', [true, false]);
  if (x['retryAfterMs'] !== undefined)
    numberField(x['retryAfterMs'], 'retryAfterMs', 0, Number.MAX_SAFE_INTEGER);
  if (x['status'] !== undefined) numberField(x['status'], 'status', 100, 599, true);
  return x as unknown as DataProviderFailure;
}
export class DataProviderError extends QuantError {
  readonly dataFailure: DataProviderFailure;
  constructor(options: DataProviderErrorOptions) {
    object(options, 'options', [
      'code',
      'guidance',
      'retryable',
      'retryAfterMs',
      'status',
      'cause',
    ]);
    const { cause, ...fields } = options;
    const safe = safeFailure({ version: 1, ...fields });
    super('query: provider failure declaration.', {
      code: safe.code,
      ...(cause === undefined ? {} : { cause }),
    });
    this.dataFailure = Object.freeze({
      ...safe,
      ...(safe.guidance ? { guidance: Object.freeze({ ...safe.guidance }) } : {}),
    });
  }
}
/** Rebuild only registered safe data. Never execute foreign toJSON or forward source text/context. */
export function providerFailure(error: unknown): QuantError {
  let safe: DataProviderFailure | undefined;
  try {
    const declaration = own(error, 'dataFailure');
    if (declaration !== undefined) safe = safeFailure(declaration);
    else {
      const code = own(error, 'code');
      const context = own(error, 'context');
      if (typeof code === 'string' && codes.has(code)) {
        const hints: Record<string, unknown> = { version: 1, code };
        for (const key of ['retryable', 'retryAfterMs', 'status']) {
          const v = own(context, key);
          if (v !== undefined) hints[key] = v;
        }
        safe = safeFailure(hints);
      }
    }
  } catch {
    /* Invalid foreign declarations are provider failures, never trusted validation diagnostics. */
  }
  const code = safe?.code ?? ErrorCode.DataProviderFailure;
  const C =
    code === ErrorCode.DataUnsupportedCapability
      ? UnsupportedError
      : code === ErrorCode.DataContractVersionUnsupported
        ? ConfigurationError
        : [ErrorCode.DataInvalidCursor, ErrorCode.DataInvalidRequest].includes(
              code as typeof ErrorCode.DataInvalidCursor,
            )
          ? InputError
          : DataError;
  const context: Record<string, unknown> = { retryable: false };
  if (safe)
    for (const key of ['retryable', 'retryAfterMs', 'status'] as const)
      if (safe[key] !== undefined) context[key] = safe[key];
  if (
    [
      ErrorCode.DataAuthenticationRequired,
      ErrorCode.DataEntitlementRequired,
      ErrorCode.DataAllowanceExhausted,
      ErrorCode.DataSnapshotExpired,
      ErrorCode.DataInvalidCursor,
      ErrorCode.DataInvalidRequest,
    ].includes(code as typeof ErrorCode.DataInvalidCursor)
  )
    context['retryable'] = false;
  let message =
    'query: provider request failed; inspect the local diagnostic cause or provider access setup.';
  if (safe) {
    message = `query: provider refused the request (${code}).`;
    if (safe.guidance) {
      context['field'] = safe.guidance.field;
      context['rule'] = safe.guidance.rule;
      message = 'query: ' + safe.guidance.field + ' ' + teaching[safe.guidance.rule] + '.';
    }
  }
  return new C(message, { code, context, cause: error });
}
