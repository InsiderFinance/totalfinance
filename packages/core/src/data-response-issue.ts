/** Controlled research validation details. Never read provider error text/context here. */
import { DataError as BaseDataError, ErrorCode, QuantError } from './errors.js';
type Phase = 'capabilities' | 'page' | 'view' | 'sequence' | 'window';
type Reason =
  | 'missing_field'
  | 'wrong_type'
  | 'not_finite'
  | 'out_of_range'
  | 'invalid_enum'
  | 'inconsistent'
  | 'out_of_order'
  | 'duplicate_identity'
  | 'invalid_structure';
export interface ResponseIssue {
  phase: Phase;
  path: string;
  reason: Reason;
  validationCode: string;
  rowIndex?: number;
  pageIndex?: number;
}
const ResearchResponseError = class DataError extends BaseDataError {
  constructor(
    readonly issue: ResponseIssue,
    door: string,
  ) {
    super(`${door}: invalid research data at ${issue.path} (${issue.reason}).`, {
      code: ErrorCode.DataInvalidResponse,
      context: { ...issue },
    });
    Object.freeze(issue);
  }
};
export function issueOf(error: unknown): ResponseIssue | undefined {
  return error instanceof ResearchResponseError ? error.issue : undefined;
}
export function responseIssue(issue: ResponseIssue, door = 'research data'): never {
  throw new ResearchResponseError(issue, door);
}
export function atResponse(
  error: unknown,
  location: { rowIndex?: number; pageIndex?: number },
  door = 'research data',
): never {
  const issue = issueOf(error);
  if (issue) responseIssue({ ...issue, ...location }, door);
  throw error;
}
// Finite normalized schema, shared by known guard failures and scanner-path projection.
const paths = new Set<string>();
function fields(prefix: string, names: string) {
  paths.add(prefix);
  for (const name of names.split(' ')) paths.add(prefix ? prefix + '.' + name : name);
}
fields(
  '',
  'contractVersion kind symbol data nextCursor provenance metadata assumptions diagnostics',
);
fields('provenance', 'provider dataset sourceVersion receivedAt asOf requestId');
fields('assumptions', 'conventionsVersion');
fields(
  'metadata',
  'datasetId datasetVersion snapshotId sessionDate sourceGeneratedTimestampMs receivedTimestampMs times consistency freshness coverage adjustment quality access executionEligibility',
);
fields('metadata.freshness', 'status configuredDelayMs evaluatedTimestampMs');
fields('metadata.coverage', 'status start end');
fields('metadata.quality', 'status issues');
fields('metadata.quality.issues[]', 'source code message');
fields(
  'data[]',
  'bar sessionDate timestampConvention times source provisional revision diagnostics sourceContractId terms quote greeks theoreticalPrice openInterestSessionDate',
);
fields('data[].bar', 'symbol timestampMs open high low close volume vwap adjusted');
fields(
  'data[].terms',
  'underlying type strike expiry root occSymbol multiplier currency style settlement expiresAt termsStatus',
);
fields(
  'data[].quote',
  'bid ask mid last mark volume openInterest underlyingPrice impliedVolatility',
);
fields('data[].greeks', 'delta gamma theta vega rho provenance');
fields('data[].greeks.provenance', 'source model timestampMs');
for (const prefix of ['metadata.times', 'data[].times'])
  fields(prefix, 'observedTimestampMs availableTimestampMs sourceStoredTimestampMs');
for (const prefix of ['diagnostics', 'data[].diagnostics']) {
  fields(prefix, 'warnings');
  fields(prefix + '.warnings[]', 'code message severity context');
}
fields('capabilities', 'contractVersion providerId providerVersion capabilities');
fields('capabilities[]', 'kind intervals maxPageSize consistency pointInTime access');
paths.add('capabilities[].intervals[]');
function allowedPath(p: string, phase: Phase): string | undefined {
  const capability =
    p === 'capabilities' || p.startsWith('capabilities[') || p.startsWith('capabilities.');
  return paths.has(p) && (phase === 'capabilities' ? capability : !capability) ? p : undefined;
}
export function schemaPath(path: string, phase: Phase = 'page', row = false): string | undefined {
  if (path === 'row') return 'data[]';
  if (path === 'bar.OHLC') return 'data[].bar';
  if (path === 'page.data.length') return 'data';
  if (path === 'row.terms.filters') return 'data[].terms';
  if (path === 'page') return 'page';
  let p = path.replace(/^page\./, '').replace(/^row\./, 'data[].');
  if (/^(bar|terms|quote|greeks)\./.test(p)) p = 'data[].' + p;
  if (/^(freshness|coverage|quality)(\.|$)/.test(p)) p = 'metadata.' + p;
  p = p.replace(/quality\.issue(?=\.|$)/, 'quality.issues[]');
  if (p.startsWith('warning')) p = (row ? 'data[].' : '') + 'diagnostics.warnings[]' + p.slice(7);
  p = p.replace(/^capability(?=\.|$)/, 'capabilities[]');
  if (phase === 'capabilities' && p.startsWith('capabilities.capabilities'))
    p = p.replace('capabilities.capabilities', 'capabilities');
  return allowedPath(p, phase);
}
const guard = Symbol('research schema guard');
/** Mark only exceptions raised by SDK guard calls. Pure input doors retain their original errors. */
export function guardFailure(error: unknown, path: string, validationCode?: string): never {
  if (error instanceof QuantError)
    Object.defineProperty(error, guard, {
      value: Object.freeze({ path, code: validationCode ?? error.code }),
    });
  throw error;
}
function reason(code: string): Reason {
  return code === ErrorCode.InputMissingField
    ? 'missing_field'
    : code === ErrorCode.InputNotFinite || code === ErrorCode.InputNaN
      ? 'not_finite'
      : code === ErrorCode.InputOutOfRange
        ? 'out_of_range'
        : code === ErrorCode.InputInvalidEnum
          ? 'invalid_enum'
          : code === ErrorCode.InputWrongType || code === ErrorCode.InputWrongShape
            ? 'wrong_type'
            : 'invalid_structure';
}
export function guardResponse(
  error: unknown,
  phase: Phase,
  location: { rowIndex?: number; pageIndex?: number } = {},
): never {
  const existing = issueOf(error);
  if (existing) responseIssue({ ...existing, ...location });
  const known =
    error instanceof QuantError
      ? (Object.getOwnPropertyDescriptor(error, guard)?.value as
          | { path: string; code: string }
          | undefined)
      : undefined;
  const path = known && schemaPath(known.path, phase, location.rowIndex !== undefined);
  responseIssue({
    phase,
    path: path ?? (phase === 'capabilities' ? 'capabilities' : 'page'),
    reason: path ? reason(known!.code) : 'invalid_structure',
    validationCode: path ? known!.code : ErrorCode.DataInvalidResponse,
    ...location,
  });
}
/** Only the SDK scanner's controlled path projection; no second walk, getters or raw messages. */
export function scanIssue(error: unknown, input: unknown, phase: Phase = 'page'): never {
  const context =
    error instanceof QuantError
      ? (Object.getOwnPropertyDescriptor(error, 'context')?.value as object | undefined)
      : undefined;
  const code =
    error instanceof QuantError
      ? (Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown)
      : undefined;
  const raw =
    context && typeof context === 'object'
      ? (Object.getOwnPropertyDescriptor(context, 'field')?.value as unknown)
      : undefined;
  if (typeof raw === 'string') {
    const numeric = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const suffix = raw.replace(/^(data|window)\.?/, '');
    const tokens = suffix.replace(/\[(\d+)\]/g, '.$1').split('.');
    const isWindow = tokens[0] === 'pages' && /^\d+$/.test(tokens[1] ?? '');
    const p = (isWindow ? tokens.slice(2) : tokens)
      .map((t) => (/^\d+$/.test(t) ? '[]' : t))
      .join('.')
      .replace(/\.\[\]/g, '[]');
    const path = allowedPath(p, phase);
    if (path && tokens.length <= 10 && numeric.every(Number.isSafeInteger)) {
      let current: unknown = input,
        stored = false;
      for (const key of tokens) {
        if (
          !current ||
          typeof current !== 'object' ||
          (/^\d+$/.test(key) && !Array.isArray(current))
        ) {
          stored = false;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) {
          stored = false;
          break;
        }
        current = descriptor.value;
        stored = true;
      }
      const finite =
        stored &&
        typeof current === 'number' &&
        !Number.isFinite(current) &&
        (code === ErrorCode.InputNaN || code === ErrorCode.InputNotFinite);
      const missing = stored && current === undefined;
      if (finite || missing)
        responseIssue({
          phase,
          path,
          reason: finite ? 'not_finite' : 'missing_field',
          validationCode: finite ? ErrorCode.InputNotFinite : ErrorCode.InputMissingField,
          ...(isWindow ? { pageIndex: numeric[0]! } : {}),
          ...(path.startsWith('data[]') ? { rowIndex: numeric[isWindow ? 1 : 0]! } : {}),
        });
    }
  }
  responseIssue({
    phase,
    path: phase === 'capabilities' ? 'capabilities' : 'page',
    reason: 'invalid_structure',
    validationCode: ErrorCode.DataInvalidResponse,
  });
}
