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
import { schemaPath } from './data-response-issue.js';
import type { Bar, OptionQuoteGreeks } from './market-data.js';
import type { Provenance } from './provenance.js';
import type {
  DataPageMetadata,
  PriceBarRecord,
  OptionChainResearchRecord,
  OptionResearchTerms,
  ObservationTimes,
  PriceBarsQuery,
  OptionChainResearchQuery,
} from './data-types.js';
/** Only finite canonical SDK schema paths or the explicit financial request fields. */
export type KnownDataField =
  | 'request.symbol'
  | 'request.from'
  | 'request.to'
  | 'request.from/to'
  | 'request.limit'
  | 'request.interval'
  | 'page'
  | 'contractVersion'
  | 'kind'
  | 'symbol'
  | 'data'
  | 'nextCursor'
  | 'provenance'
  | 'metadata'
  | 'assumptions'
  | 'diagnostics'
  | 'binding'
  | 'timestampConvention'
  | 'issues'
  | `provenance.${Exclude<keyof Provenance, 'warnings'>}`
  | 'assumptions.conventionsVersion'
  | `metadata.${keyof DataPageMetadata}`
  | `metadata.times.${keyof ObservationTimes}`
  | `data[].times.${keyof ObservationTimes}`
  | `metadata.freshness.${keyof DataPageMetadata['freshness']}`
  | `metadata.coverage.${keyof DataPageMetadata['coverage']}`
  | `metadata.quality.${keyof DataPageMetadata['quality']}`
  | 'metadata.quality.issues[]'
  | `metadata.quality.issues[].${'source' | 'code' | 'message'}`
  | 'data[]'
  | `data[].${keyof PriceBarRecord | keyof OptionChainResearchRecord}`
  | `data[].bar.${keyof Bar}`
  | `data[].terms.${keyof OptionResearchTerms}`
  | `data[].quote.${keyof OptionChainResearchRecord['quote']}`
  | `data[].greeks.${keyof OptionQuoteGreeks}`
  | `data[].greeks.provenance.${'source' | 'model' | 'timestampMs'}`
  | `${'diagnostics' | 'data[].diagnostics'}.warnings`
  | `${'diagnostics' | 'data[].diagnostics'}.warnings[]`
  | `${'diagnostics' | 'data[].diagnostics'}.warnings[].${'code' | 'message' | 'severity' | 'context'}`
  | 'capabilities'
  | 'capabilities[]'
  | 'capabilities[].intervals[]'
  | `capabilities.${'contractVersion' | 'providerId' | 'providerVersion' | 'capabilities'}`
  | `capabilities[].${'kind' | 'intervals' | 'maxPageSize' | 'consistency' | 'pointInTime' | 'access' | 'maxWindowMs' | 'maxSessionDays'}`
  | 'binding.provider'
  | 'binding.query'
  | 'binding.query.snapshot'
  | `binding.provider.${'id' | 'version'}`
  | `binding.query.${keyof PriceBarsQuery | keyof OptionChainResearchQuery}`
  | `binding.query.snapshot.${'kind' | 'sessionDate' | 'snapshotId'}`;
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
// Portable author refusals admit only these existing general input rules.
const inputCodes = new Set<string>([
  ErrorCode.InputWrongType,
  ErrorCode.InputMissingField,
  ErrorCode.InputNotFinite,
  ErrorCode.InputOutOfRange,
  ErrorCode.InputInvalidEnum,
]);
const codes = new Set<string>([
  ...inputCodes,
  ErrorCode.DataSuspectObservations,
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
/** Opt-in compatibility only: registered own data, never class identity or foreign text/getters. */
export function registeredDataRefusal(
  value: unknown,
): { code: string; context: unknown } | undefined {
  try {
    const code = own(value, 'code');
    if (typeof code !== 'string' || !codes.has(code)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'context');
    if (descriptor && !('value' in descriptor)) return undefined;
    const context = descriptor?.value;
    if (context !== undefined) {
      scanCanonicalData(context, {
        functionName: 'data refusal',
        label: 'context',
        requireFiniteNumbers: true,
        maximumWorkUnits: 1000,
      });
    }
    return {
      code,
      context: context === undefined ? undefined : JSON.parse(JSON.stringify(context)),
    };
  } catch {
    return undefined;
  }
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
    const field = g['field'];
    if (
      typeof field !== 'string' ||
      (!fields.includes(field) &&
        schemaPath(field) !== field &&
        schemaPath(field, 'capabilities') !== field)
    )
      fail('guidance.field', ErrorCode.InputInvalidEnum);
    enumField(g['rule'], 'guidance.rule', Object.keys(teaching));
  }
  if (x['retryable'] !== undefined) enumField(x['retryable'], 'retryable', [true, false]);
  if (x['retryAfterMs'] !== undefined)
    numberField(x['retryAfterMs'], 'retryAfterMs', 0, Number.MAX_SAFE_INTEGER);
  if (x['status'] !== undefined) numberField(x['status'], 'status', 100, 599, true);
  return x as unknown as DataProviderFailure;
}
function declaredOptions(options: DataProviderErrorOptions) {
  try {
    object(options, 'options', [
      'code',
      'guidance',
      'retryable',
      'retryAfterMs',
      'status',
      'cause',
    ]);
    const { cause, ...fields } = options;
    return { cause, safe: safeFailure({ version: 1, ...fields }) };
  } catch (error) {
    if (error instanceof QuantError)
      error.message = 'DataProviderError: ' + error.message.replace(/^[^:]*:\s*/, '');
    throw error;
  }
}
export class DataProviderError extends QuantError {
  readonly dataFailure: DataProviderFailure;
  constructor(options: DataProviderErrorOptions) {
    const { cause, safe } = declaredOptions(options);
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
      const refusal = registeredDataRefusal(error);
      if (refusal) {
        const { code, context } = refusal;
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
        : inputCodes.has(code) ||
            [ErrorCode.DataInvalidCursor, ErrorCode.DataInvalidRequest].includes(
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
