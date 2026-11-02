/** Internal validation shared by the structural wrapper and independent conformance kit. */
import {
  ErrorCode,
  InputError,
  UnsupportedError,
  ConfigurationError,
  DataError,
} from './errors.js';
import { ensureKnownKeys, requireArgumentObject } from './invariants.js';
import { isoDateToEpochMs } from './dates.js';
import { requireProvenance } from './provenance.js';
import { scanCanonicalData } from './artifacts/canonical-scan.js';
import { canonicalJsonOf } from './canonical-json.js';
import { deepFreeze } from './artifacts/deep-freeze.js';
import type {
  DataCapabilities,
  DataPage,
  DataRequest,
  DataProvider,
  PriceBarRecord,
  OptionChainResearchRecord,
} from './data-types.js';

type RecordValue = Record<string, unknown>;
const FUNCTION = 'defineDataProvider';
export function object(value: unknown, path: string, keys?: readonly string[]): RecordValue {
  requireArgumentObject(FUNCTION, path, value);
  if (keys) ensureKnownKeys(FUNCTION, path, value as object, keys);
  return value as RecordValue;
}
export function fail(path: string, code: string = ErrorCode.InputWrongType): never {
  throw new InputError(
    `${FUNCTION}: ${path} is missing or invalid; supply the declared field type and units.`,
    { code, context: { field: path } },
  );
}
export function textField(value: unknown, path: string, maximum = 2048): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) fail(path);
}
export function numberField(
  value: unknown,
  path: string,
  minimum = -Infinity,
  maximum = Infinity,
  integer = false,
): asserts value is number {
  if (typeof value !== 'number') fail(path);
  if (!Number.isFinite(value)) fail(path, ErrorCode.InputNotFinite);
  if (value < minimum || value > maximum || (integer && !Number.isSafeInteger(value)))
    fail(path, ErrorCode.InputOutOfRange);
}
export function enumField(value: unknown, path: string, values: readonly unknown[]): void {
  if (!values.includes(value)) fail(path, ErrorCode.InputInvalidEnum);
}
function nullableText(value: unknown, path: string): void {
  if (value !== null) textField(value, path);
}
function instant(value: unknown, path: string): void {
  numberField(value, path, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
}
function nullableInstant(value: unknown, path: string): void {
  if (value !== null) instant(value, path);
}
export function calendarDate(value: unknown, path: string): number {
  textField(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path);
  return isoDateToEpochMs(value);
}
function nullableDate(value: unknown, path: string): void {
  if (value !== null) calendarDate(value, path);
}
function zonedInstant(value: unknown, path: string): number {
  textField(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value))
    fail(path);
  calendarDate(value.slice(0, 10), path);
  const clock = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)!;
  if (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59) fail(path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(path);
  return parsed;
}
export function plain(value: unknown): void {
  scanCanonicalData(value, {
    functionName: FUNCTION,
    label: 'data',
    requireFiniteNumbers: true,
    maximumWorkUnits: 2_000_000,
  });
}
export function copyFrozen<T>(value: T): T {
  plain(value);
  return deepFreeze(JSON.parse(canonicalJsonOf(value)) as T);
}
export function frozen(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== 'object' ||
    (Object.isFrozen(value) && Object.values(value).every(frozen))
  );
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path);
  return value;
}
export function version(value: unknown): void {
  if (value !== 1)
    throw new ConfigurationError(`${FUNCTION}: only data contract version 1 is supported.`, {
      code: ErrorCode.DataContractVersionUnsupported,
    });
}
export function signalField(value: unknown): asserts value is AbortSignal | undefined {
  if (value === undefined) return;
  const s = object(value, 'signal');
  if (
    typeof s['aborted'] !== 'boolean' ||
    typeof s['addEventListener'] !== 'function' ||
    typeof s['removeEventListener'] !== 'function'
  )
    fail('signal');
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DataError(`${FUNCTION}: request cancelled by the caller.`, {
      code: ErrorCode.DataAborted,
    });
}
export function providerShape(value: unknown): asserts value is DataProvider {
  const p = object(value, 'provider');
  textField(p['id'], 'provider.id');
  textField(p['version'], 'provider.version');
  version(p['contractVersion']);
  for (const method of ['query', 'capabilities'])
    if (typeof p[method] !== 'function') fail(`provider.${method}`);
}
export function requestData(value: unknown): asserts value is DataRequest {
  const r = object(value, 'request');
  if (!['price-bars', 'option-chain-research'].includes(r['kind'] as string))
    throw new UnsupportedError(`${FUNCTION}: requested data capability is unsupported.`, {
      code: ErrorCode.DataUnsupportedCapability,
    });
  textField(r['symbol'], 'request.symbol', 128);
  numberField(r['limit'], 'request.limit', 1, 2000, true);
  if (r['cursor'] !== undefined) {
    object(value, 'request', ['kind', 'symbol', 'cursor', 'limit']);
    textField(r['cursor'], 'request.cursor', 16384);
    return;
  }
  if (r['kind'] === 'price-bars') {
    object(value, 'request', ['kind', 'symbol', 'interval', 'from', 'to', 'limit']);
    if (!['1d', '1m'].includes(r['interval'] as string))
      throw new UnsupportedError(`${FUNCTION}: interval must be 1d or 1m.`, {
        code: ErrorCode.DataUnsupportedCapability,
      });
    const parse = r['interval'] === '1d' ? calendarDate : zonedInstant;
    const from = parse(r['from'], 'request.from');
    const to = parse(r['to'], 'request.to');
    if (from > to || (r['interval'] === '1m' && to - from > 31 * 86400000))
      fail('request.from/to', ErrorCode.InputOutOfRange);
  } else {
    object(value, 'request', [
      'kind',
      'symbol',
      'snapshot',
      'expirationFrom',
      'expirationTo',
      'rights',
      'minStrike',
      'maxStrike',
      'limit',
    ]);
    const s = object(r['snapshot'], 'request.snapshot');
    enumField(s['kind'], 'snapshot.kind', ['latest', 'session', 'id']);
    const field =
      s['kind'] === 'session' ? 'sessionDate' : s['kind'] === 'id' ? 'snapshotId' : null;
    object(s, 'request.snapshot', field ? ['kind', field] : ['kind']);
    if (field === 'sessionDate') calendarDate(s[field], 'snapshot.sessionDate');
    if (field === 'snapshotId') textField(s[field], 'snapshot.snapshotId');
    for (const key of ['expirationFrom', 'expirationTo'])
      if (r[key] !== undefined) calendarDate(r[key], `request.${key}`);
    for (const key of ['minStrike', 'maxStrike'])
      if (r[key] !== undefined) numberField(r[key], `request.${key}`, Number.MIN_VALUE);
    for (const [from, to] of [
      ['expirationFrom', 'expirationTo'],
      ['minStrike', 'maxStrike'],
    ] as const) {
      if (r[from] !== undefined && r[to] !== undefined && r[from]! > r[to]!)
        fail(`request.${from}/${to}`, ErrorCode.InputOutOfRange);
    }
    if (r['rights'] !== undefined) {
      const rights = array(r['rights'], 'request.rights');
      if (!rights.length || rights.length > 2 || new Set(rights).size !== rights.length)
        fail('request.rights');
      for (const v of rights) enumField(v, 'request.rights', ['call', 'put']);
    }
  }
}
export function capabilityData(
  value: unknown,
  provider: Pick<DataProvider, 'id' | 'version'>,
): asserts value is DataCapabilities {
  plain(value);
  const c = object(value, 'capabilities', [
    'contractVersion',
    'providerId',
    'providerVersion',
    'capabilities',
  ]);
  version(c['contractVersion']);
  if (c['providerId'] !== provider.id || c['providerVersion'] !== provider.version)
    fail('capabilities.identity');
  const seen = new Set();
  for (const item of array(c['capabilities'], 'capabilities.capabilities')) {
    const a = object(item, 'capability', [
      'kind',
      'intervals',
      'maxPageSize',
      'consistency',
      'pointInTime',
      'access',
    ]);
    enumField(a['kind'], 'capability.kind', ['price-bars', 'option-chain-research']);
    if (seen.has(a['kind'])) fail('capability.kind');
    seen.add(a['kind']);
    numberField(a['maxPageSize'], 'capability.maxPageSize', 1, 2000, true);
    enumField(a['consistency'], 'capability.consistency', ['snapshot', 'best-effort']);
    enumField(a['pointInTime'], 'capability.pointInTime', [false]);
    enumField(a['access'], 'capability.access', ['unknown', 'granted', 'denied']);
    const intervals = array(a['intervals'], 'capability.intervals');
    if (
      new Set(intervals).size !== intervals.length ||
      (a['kind'] === 'price-bars' ? !intervals.length : intervals.length !== 0)
    )
      fail('capability.intervals');
    for (const i of intervals) enumField(i, 'capability.intervals', ['1d', '1m']);
  }
}
function times(value: unknown, path: string): void {
  const t = object(value, path, [
    'observedTimestampMs',
    'availableTimestampMs',
    'sourceStoredTimestampMs',
  ]);
  for (const k of ['observedTimestampMs', 'availableTimestampMs', 'sourceStoredTimestampMs'])
    nullableInstant(t[k], `${path}.${k}`);
  if (
    typeof t['observedTimestampMs'] === 'number' &&
    typeof t['availableTimestampMs'] === 'number' &&
    t['availableTimestampMs'] < t['observedTimestampMs']
  )
    fail(path);
}
function diagnostics(value: unknown, path: string): void {
  const d = object(value, path);
  const warnings = array(d['warnings'], `${path}.warnings`);
  for (const w of warnings) {
    const warning = object(w, 'warning', ['code', 'message', 'severity', 'context']);
    textField(warning['code'], 'warning.code');
    textField(warning['message'], 'warning.message', 16384);
    enumField(warning['severity'], 'warning.severity', ['info', 'warn', 'error']);
    if (warning['context'] !== undefined) object(warning['context'], 'warning.context');
  }
}
function barData(value: unknown, symbol: string): void {
  const r = object(value, 'row');
  const b = object(r['bar'], 'row.bar');
  if (b['symbol'] !== symbol) fail('row.bar.symbol');
  instant(b['timestampMs'], 'row.bar.timestampMs');
  for (const k of ['open', 'high', 'low', 'close']) numberField(b[k], `bar.${k}`);
  for (const k of ['volume', 'vwap'])
    if (b[k] !== undefined) numberField(b[k], `bar.${k}`, k === 'volume' ? 0 : -Infinity);
  if (b['adjusted'] !== undefined) enumField(b['adjusted'], 'bar.adjusted', [true, false]);
  if (
    (b['low'] as number) > Math.min(b['open'] as number, b['close'] as number) ||
    (b['high'] as number) < Math.max(b['open'] as number, b['close'] as number) ||
    (b['low'] as number) > (b['high'] as number)
  )
    fail('bar.OHLC');
  nullableDate(r['sessionDate'], 'row.sessionDate');
  enumField(r['timestampConvention'], 'row.timestampConvention', [
    'session-label-midnight-utc',
    'interval-start',
  ]);
  if (
    r['timestampConvention'] === 'session-label-midnight-utc' &&
    calendarDate(r['sessionDate'], 'row.sessionDate') !== b['timestampMs']
  )
    fail('bar.timestampMs');
  times(r['times'], 'row.times');
  nullableText(r['source'], 'row.source');
  enumField(r['provisional'], 'row.provisional', [true, false, null]);
  if (r['revision'] !== null)
    numberField(r['revision'], 'row.revision', 0, Number.MAX_SAFE_INTEGER, true);
  diagnostics(r['diagnostics'], 'row.diagnostics');
}
function chainData(value: unknown, symbol: string): void {
  const r = object(value, 'row');
  textField(r['sourceContractId'], 'row.sourceContractId');
  const t = object(r['terms'], 'row.terms');
  if (t['underlying'] !== symbol) fail('terms.underlying');
  enumField(t['type'], 'terms.type', ['call', 'put']);
  numberField(t['strike'], 'terms.strike', Number.MIN_VALUE);
  calendarDate(t['expiry'], 'terms.expiry');
  for (const k of ['root', 'occSymbol', 'currency']) nullableText(t[k], `terms.${k}`);
  if (t['multiplier'] !== null) numberField(t['multiplier'], 'terms.multiplier', Number.MIN_VALUE);
  enumField(t['style'], 'terms.style', ['american', 'european', null]);
  enumField(t['settlement'], 'terms.settlement', ['cash', 'physical', null]);
  nullableInstant(t['expiresAt'], 'terms.expiresAt');
  enumField(t['termsStatus'], 'terms.termsStatus', ['verified', 'incomplete']);
  if (
    t['termsStatus'] === 'verified' &&
    ['multiplier', 'currency', 'style', 'settlement', 'expiresAt'].some((k) => t[k] === null)
  )
    fail('terms.termsStatus');
  const q = object(r['quote'], 'row.quote');
  for (const k of [
    'bid',
    'ask',
    'mid',
    'last',
    'mark',
    'volume',
    'openInterest',
    'underlyingPrice',
    'impliedVolatility',
  ])
    if (q[k] !== undefined)
      numberField(
        q[k],
        `quote.${k}`,
        ['volume', 'openInterest', 'impliedVolatility'].includes(k) ? 0 : -Infinity,
      );
  if (r['greeks'] !== null) {
    const g = object(r['greeks'], 'row.greeks');
    numberField(g['delta'], 'greeks.delta');
    for (const k of ['gamma', 'theta', 'vega', 'rho'])
      if (g[k] !== undefined) numberField(g[k], `greeks.${k}`);
    if (g['provenance'] !== undefined) {
      const p = object(g['provenance'], 'greeks.provenance');
      textField(p['source'], 'greeks.provenance.source');
      if (p['model'] !== undefined) textField(p['model'], 'greeks.provenance.model');
      if (p['timestampMs'] !== undefined)
        instant(p['timestampMs'], 'greeks.provenance.timestampMs');
    }
  }
  if (r['theoreticalPrice'] !== null) numberField(r['theoreticalPrice'], 'row.theoreticalPrice');
  nullableDate(r['openInterestSessionDate'], 'row.openInterestSessionDate');
  times(r['times'], 'row.times');
  diagnostics(r['diagnostics'], 'row.diagnostics');
}
/** Stable order keys used by both wrapper and cross-page kit checks. */
export function rowKey(
  kind: string,
  row: PriceBarRecord | OptionChainResearchRecord,
): readonly (string | number)[] {
  if (kind === 'price-bars') return [(row as PriceBarRecord).bar.timestampMs];
  const r = row as OptionChainResearchRecord;
  return [r.terms.expiry, r.terms.strike, r.terms.type === 'call' ? 0 : 1];
}
export function compareKeys(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}
export function pageData(
  value: unknown,
  request?: DataRequest,
  provider?: Pick<DataProvider, 'id' | 'version'>,
): asserts value is DataPage<PriceBarRecord | OptionChainResearchRecord> {
  plain(value);
  const p = object(value, 'page');
  version(p['contractVersion']);
  enumField(p['kind'], 'page.kind', ['price-bars', 'option-chain-research']);
  textField(p['symbol'], 'page.symbol', 128);
  if (request && (p['kind'] !== request.kind || p['symbol'] !== request.symbol))
    fail('page.resource');
  const rows = array(p['data'], 'page.data');
  if (rows.length > (request?.limit ?? 2000)) fail('page.data.length');
  if (p['nextCursor'] !== null) textField(p['nextCursor'], 'page.nextCursor', 16384);
  if (
    p['nextCursor'] !== null &&
    (!rows.length || (request && 'cursor' in request && p['nextCursor'] === request.cursor))
  )
    fail('page.nextCursor');
  requireProvenance(FUNCTION, 'page.provenance', p['provenance']);
  const provenance = p['provenance'] as RecordValue;
  textField(provenance['provider'], 'page.provenance.provider');
  if (provider && provenance['provider'] !== provider.id) fail('page.provenance.provider');
  textField(provenance['dataset'], 'page.provenance.dataset');
  const m = object(p['metadata'], 'metadata');
  for (const k of ['datasetId', 'datasetVersion']) textField(m[k], `metadata.${k}`);
  if (
    provenance['dataset'] !== m['datasetId'] ||
    provenance['sourceVersion'] !== m['datasetVersion'] ||
    provenance['receivedAt'] !== m['receivedTimestampMs']
  )
    fail('page.provenance');
  nullableText(m['snapshotId'], 'metadata.snapshotId');
  nullableDate(m['sessionDate'], 'metadata.sessionDate');
  nullableInstant(m['sourceGeneratedTimestampMs'], 'metadata.sourceGeneratedTimestampMs');
  instant(m['receivedTimestampMs'], 'metadata.receivedTimestampMs');
  times(m['times'], 'metadata.times');
  const mt = m['times'] as RecordValue;
  if (provenance['asOf'] !== undefined && provenance['asOf'] !== mt['observedTimestampMs'])
    fail('provenance.asOf');
  enumField(m['consistency'], 'metadata.consistency', ['snapshot', 'best-effort']);
  if (m['consistency'] === 'snapshot' && m['snapshotId'] === null) fail('metadata.snapshotId');
  enumField(m['executionEligibility'], 'metadata.executionEligibility', ['research-only']);
  enumField(m['access'], 'metadata.access', ['unknown', 'granted', 'denied']);
  enumField(m['adjustment'], 'metadata.adjustment', [
    'unadjusted',
    'split',
    'split-and-dividend',
    'unknown',
  ]);
  const f = object(m['freshness'], 'freshness');
  enumField(f['status'], 'freshness.status', [
    'current',
    'stale',
    'session-closed',
    'historical',
    'end-of-day',
    'stored',
    'unknown',
  ]);
  if (f['configuredDelayMs'] !== null)
    numberField(f['configuredDelayMs'], 'freshness.configuredDelayMs', 0);
  nullableInstant(f['evaluatedTimestampMs'], 'freshness.evaluatedTimestampMs');
  const c = object(m['coverage'], 'coverage');
  enumField(c['status'], 'coverage.status', ['continuous', 'observed-only', 'unknown']);
  nullableText(c['start'], 'coverage.start');
  nullableText(c['end'], 'coverage.end');
  if (
    (c['start'] === null) !== (c['end'] === null) ||
    (c['start'] !== null && (c['start'] as string) > (c['end'] as string)) ||
    (c['status'] === 'continuous' && c['start'] === null)
  )
    fail('coverage');
  const quality = object(m['quality'], 'quality');
  enumField(quality['status'], 'quality.status', ['complete', 'partial', 'unavailable', 'unknown']);
  for (const item of array(quality['issues'], 'quality.issues')) {
    const q = object(item, 'quality.issue');
    for (const k of ['source', 'code', 'message']) textField(q[k], `quality.issue.${k}`, 16384);
  }
  const assumptions = object(p['assumptions'], 'assumptions');
  textField(assumptions['conventionsVersion'], 'assumptions.conventionsVersion');
  diagnostics(p['diagnostics'], 'page.diagnostics');
  if (request?.kind === 'option-chain-research' && !('cursor' in request)) {
    if (request.snapshot.kind === 'id' && request.snapshot.snapshotId !== m['snapshotId'])
      fail('metadata.snapshotId');
    if (request.snapshot.kind === 'session' && request.snapshot.sessionDate !== m['sessionDate'])
      fail('metadata.sessionDate');
  }
  let previous: readonly (string | number)[] | undefined;
  const ids = new Set();
  for (const row of rows) {
    if (p['kind'] === 'price-bars') barData(row, p['symbol'] as string);
    else chainData(row, p['symbol'] as string);
    const r = row as PriceBarRecord | OptionChainResearchRecord;
    const rowTimes = r.times as unknown as RecordValue;
    for (const clock of ['observedTimestampMs', 'availableTimestampMs', 'sourceStoredTimestampMs'])
      if (mt[clock] !== null && rowTimes[clock] !== mt[clock]) fail('metadata.times.' + clock);
    if (request && !('cursor' in request)) {
      if (request.kind === 'price-bars') {
        const record = r as PriceBarRecord;
        const parse = request.interval === '1d' ? calendarDate : zonedInstant;
        if (
          record.bar.timestampMs < parse(request.from, 'from') ||
          record.bar.timestampMs > parse(request.to, 'to')
        )
          fail('row.bar.timestampMs');
        if (
          record.timestampConvention !==
          (request.interval === '1d' ? 'session-label-midnight-utc' : 'interval-start')
        )
          fail('row.timestampConvention');
      } else {
        const terms = (r as OptionChainResearchRecord).terms;
        if (
          (request.expirationFrom !== undefined && terms.expiry < request.expirationFrom) ||
          (request.expirationTo !== undefined && terms.expiry > request.expirationTo) ||
          (request.minStrike !== undefined && terms.strike < request.minStrike) ||
          (request.maxStrike !== undefined && terms.strike > request.maxStrike) ||
          (request.rights !== undefined && !request.rights.includes(terms.type))
        )
          fail('row.terms.filters');
      }
    }
    const key = rowKey(p['kind'] as string, r);
    if (previous && compareKeys(previous, key) >= 0) fail('page.data.order');
    previous = key;
    const id =
      p['kind'] === 'price-bars'
        ? String(key[0])
        : (r as OptionChainResearchRecord).sourceContractId;
    if (ids.has(id)) fail('page.data.identity');
    ids.add(id);
  }
}
