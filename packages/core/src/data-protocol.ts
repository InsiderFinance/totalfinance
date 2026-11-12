/** Protocol2 normalization: explicit source facts once, common canonical validation and pins. */
import { CONVENTIONS_VERSION } from './assumptions.js';
import { ErrorCode, DataError, ConfigurationError, UnsupportedError } from './errors.js';
import { canonicalJsonOf } from './canonical-json.js';
import { deepFreeze } from './artifacts/deep-freeze.js';
import { scanCanonicalData } from './artifacts/canonical-scan.js';
import {
  object,
  textField,
  numberField,
  enumField,
  fail,
  calendarDate,
  zonedInstant,
  pageData,
} from './data-validation.js';
import { guardResponse, issueOf, responseIssue, scanIssue } from './data-response-issue.js';
import { requestData as legacyRequest } from './data-validation.js';
import type {
  DataQuery,
  DataProviderSource,
  DataCapabilities,
  DataCapability,
  DataPage,
  PriceBarRecord,
  OptionChainResearchRecord,
  DataPins,
  DataQueryBinding,
  DataContinuation,
  DataCapabilityDeclaration,
} from './data-types.js';
export const intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo'] as const;
export const sessionInterval = (interval: string): boolean =>
  ['1d', '1w', '1mo'].includes(interval);
export function freezeData<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJsonOf(value)) as T);
}
export function equalData(a: unknown, b: unknown): boolean {
  return canonicalJsonOf(a) === canonicalJsonOf(b);
}
export function bounded(value: unknown, label = 'data', maximumWorkUnits = 2_000_000): void {
  try {
    scanCanonicalData(value, {
      functionName: 'research data',
      label,
      requireFiniteNumbers: true,
      maximumWorkUnits,
    });
  } catch (error) {
    scanIssue(
      error,
      value,
      label === 'capabilities' ? 'capabilities' : 'page',
      label === 'sourcePage',
    );
  }
}
export function byteSize(value: unknown): number {
  return new TextEncoder().encode(canonicalJsonOf(value)).length;
}
export function invalid(
  path: string,
  reason: 'inconsistent' | 'out_of_range' | 'invalid_structure' = 'inconsistent',
  rowIndex?: number,
): never {
  responseIssue({
    phase: 'page',
    path,
    reason,
    validationCode: ErrorCode.DataInvalidResponse,
    ...(rowIndex === undefined ? {} : { rowIndex }),
  });
}
export function sourceShape(value: unknown): asserts value is DataProviderSource {
  const s = object(value, 'provider', [
    'protocol',
    'contractVersion',
    'id',
    'version',
    'query',
    'capabilities',
  ]);
  if (s['protocol'] !== 'totalfinance-data-source' || s['contractVersion'] !== 2)
    throw new ConfigurationError(
      'connect: supply a protocol2 raw provider source, not a validated consumer wrapper.',
      { code: ErrorCode.DataContractVersionUnsupported },
    );
  textField(s['id'], 'provider.id');
  textField(s['version'], 'provider.version');
  for (const k of ['query', 'capabilities']) if (typeof s[k] !== 'function') fail('provider.' + k);
}
export function queryData(value: unknown): asserts value is DataQuery {
  const q = object(value, 'request');
  textField(q['symbol'], 'request.symbol', 128);
  if (q['kind'] === 'option-chain-research') {
    object(value, 'request', [
      'kind',
      'symbol',
      'snapshot',
      'expirationFrom',
      'expirationTo',
      'rights',
      'minStrike',
      'maxStrike',
    ]);
    legacyRequest({ ...q, limit: 1 });
    return;
  }
  if (q['kind'] !== 'price-bars')
    throw new UnsupportedError('query: unsupported data capability.', {
      code: ErrorCode.DataUnsupportedCapability,
    });
  object(value, 'request', ['kind', 'symbol', 'interval', 'from', 'to']);
  if (!intervals.includes(q['interval'] as (typeof intervals)[number]))
    throw new UnsupportedError('query: interval is not in the understood research interval set.', {
      code: ErrorCode.DataUnsupportedCapability,
    });
  const parse = sessionInterval(q['interval'] as string) ? calendarDate : zonedInstant;
  if (parse(q['from'], 'request.from') > parse(q['to'], 'request.to'))
    fail('request.from/to', ErrorCode.InputOutOfRange);
}
export function bindingData(value: unknown): asserts value is DataQueryBinding {
  const b = object(value, 'binding', ['provider', 'query']);
  const p = object(b['provider'], 'binding.provider', ['id', 'version']);
  textField(p['id'], 'binding.provider.id');
  textField(p['version'], 'binding.provider.version');
  queryData(b['query']);
}
export function pinOf(page: DataPage<PriceBarRecord | OptionChainResearchRecord>): DataPins {
  if (page.contractVersion !== 2 || !page.binding) invalid('binding');
  const m = page.metadata;
  return freezeData({
    datasetId: m.datasetId,
    datasetVersion: m.datasetVersion,
    snapshotId: m.snapshotId,
    sessionDate: m.sessionDate,
    adjustment: m.adjustment,
    consistency: m.consistency,
    temporal:
      page.binding.query.kind === 'price-bars'
        ? {
            kind: 'price-bars',
            interval: page.binding.query.interval,
            timestampConvention: page.timestampConvention!,
          }
        : { kind: 'option-chain-research' },
  });
}
export function continuationOf(
  page: DataPage<PriceBarRecord | OptionChainResearchRecord>,
): DataContinuation | null {
  return page.contractVersion === 2 && page.nextCursor !== null && page.binding
    ? freezeData({ version: 2, binding: page.binding, cursor: page.nextCursor, pins: pinOf(page) })
    : null;
}
export function continuationData(
  value: unknown,
  query: DataQuery,
  provider: { id: string; version: string },
): asserts value is DataContinuation {
  bounded(value);
  const c = object(value, 'continuation', ['version', 'binding', 'cursor', 'pins']);
  bindingData(c['binding']);
  textField(c['cursor'], 'continuation.cursor', 16384);
  if (
    c['version'] !== 2 ||
    !equalData((c['binding'] as DataQueryBinding).query, query) ||
    !equalData((c['binding'] as DataQueryBinding).provider, provider)
  )
    throw new DataError('query: continuation belongs to a different query or provider binding.', {
      code: ErrorCode.DataInvalidCursor,
    });
  pinsData(c['pins'], query);
}
export function pinsData(value: unknown, query: DataQuery): asserts value is DataPins {
  const p = object(value, 'pins', [
    'datasetId',
    'datasetVersion',
    'snapshotId',
    'sessionDate',
    'adjustment',
    'consistency',
    'temporal',
  ]);
  for (const k of ['datasetId', 'datasetVersion']) textField(p[k], 'pins.' + k);
  if (p['snapshotId'] !== null) textField(p['snapshotId'], 'pins.snapshotId');
  if (p['sessionDate'] !== null) calendarDate(p['sessionDate'], 'pins.sessionDate');
  enumField(p['adjustment'], 'pins.adjustment', [
    'unadjusted',
    'split',
    'split-and-dividend',
    'unknown',
  ]);
  enumField(p['consistency'], 'pins.consistency', ['snapshot', 'best-effort']);
  const t = object(
    p['temporal'],
    'pins.temporal',
    query.kind === 'price-bars' ? ['kind', 'interval', 'timestampConvention'] : ['kind'],
  );
  if (t['kind'] !== query.kind) fail('pins.temporal.kind');
  if (query.kind === 'price-bars') {
    if (t['interval'] !== query.interval) fail('pins.temporal.interval');
    enumField(
      t['timestampConvention'],
      'pins.temporal.timestampConvention',
      sessionInterval(query.interval)
        ? ['session-start', 'session-label-midnight-utc']
        : ['interval-start'],
    );
  }
  if (p['consistency'] === 'snapshot' && p['snapshotId'] === null) fail('pins.snapshotId');
  if (query.kind === 'option-chain-research') {
    if (query.snapshot.kind === 'id' && query.snapshot.snapshotId !== p['snapshotId'])
      fail('pins.snapshotId');
    if (query.snapshot.kind === 'session' && query.snapshot.sessionDate !== p['sessionDate'])
      fail('pins.sessionDate');
  }
}
export function capabilityList(
  value: unknown,
  provider: { id: string; version: string },
): DataCapabilities {
  try {
    bounded(value, 'capabilities');
    if (!Array.isArray(value) || value.length > 64) fail('capabilities');
    const known: DataCapability[] = [],
      ignored = { kinds: 0, intervals: 0 },
      seen = new Set<string>();
    for (const raw of value) {
      const x = object(raw, 'capability');
      textField(x['kind'], 'capability.kind', 128);
      const kind = x['kind'] as string;
      if (seen.has(kind)) fail('capability.kind');
      seen.add(kind);
      if (!['price-bars', 'option-chain-research'].includes(kind)) {
        ignored.kinds++;
        continue;
      }
      object(raw, 'capability', [
        'kind',
        'intervals',
        'maxPageSize',
        'consistency',
        'pointInTime',
        'access',
        'maxWindowMs',
        'maxSessionDays',
      ]);
      numberField(x['maxPageSize'], 'capability.maxPageSize', 1, Number.MAX_SAFE_INTEGER, true);
      enumField(x['pointInTime'], 'capability.pointInTime', [false]);
      enumField(x['access'], 'capability.access', ['unknown', 'granted', 'denied']);
      if (
        !Array.isArray(x['consistency']) ||
        !x['consistency'].length ||
        new Set(x['consistency']).size !== x['consistency'].length
      )
        fail('capability.consistency');
      for (const mode of x['consistency'])
        enumField(mode, 'capability.consistency', ['snapshot', 'best-effort']);
      for (const key of ['maxWindowMs', 'maxSessionDays'])
        if (x[key] !== undefined)
          numberField(x[key], 'capability.' + key, 1, Number.MAX_SAFE_INTEGER, true);
      const tokens = x['intervals'];
      if (!Array.isArray(tokens) || tokens.length > 64 || new Set(tokens).size !== tokens.length)
        fail('capability.intervals');
      const understood: (typeof intervals)[number][] = [];
      for (const token of tokens) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(token))
          fail('capability.intervals');
        if (intervals.includes(token as (typeof intervals)[number]))
          understood.push(token as (typeof intervals)[number]);
        else ignored.intervals++;
      }
      if (kind === 'option-chain-research' && tokens.length) fail('capability.intervals');
      if (kind === 'price-bars' && !tokens.length) fail('capability.intervals');
      if (kind === 'price-bars' && !understood.length) continue;
      known.push({ ...x, kind, intervals: understood } as unknown as DataCapability);
    }
    return freezeData({
      contractVersion: 2,
      providerId: provider.id,
      providerVersion: provider.version,
      capabilities: known,
      ignored,
    });
  } catch (e) {
    guardResponse(e, 'capabilities');
  }
}
export function checkCapability(query: DataQuery, cap: DataCapability): void {
  if (
    cap.kind !== query.kind ||
    (query.kind === 'price-bars' && !cap.intervals.includes(query.interval))
  )
    throw new UnsupportedError('priceBars: requested capability is unsupported.', {
      code: ErrorCode.DataUnsupportedCapability,
    });
  if (cap.access === 'denied')
    throw new DataError('priceBars: provider entitlement required.', {
      code: ErrorCode.DataEntitlementRequired,
    });
  if (query.kind === 'price-bars') {
    const session = sessionInterval(query.interval),
      parse = session ? calendarDate : zonedInstant;
    const span = parse(query.to, 'request.to') - parse(query.from, 'request.from');
    if (
      (!session && cap.maxWindowMs !== undefined && span > cap.maxWindowMs) ||
      (session && cap.maxSessionDays !== undefined && span / 86400000 + 1 > cap.maxSessionDays)
    )
      fail('request.from/to', ErrorCode.InputOutOfRange);
  }
}
const unknownTimes = {
  observedTimestampMs: null,
  availableTimestampMs: null,
  sourceStoredTimestampMs: null,
};
const emptyDiagnostics = { warnings: [] };
export function materialize(
  raw: unknown,
  binding: DataQueryBinding,
  limit: number,
  pins: DataPins | null,
): DataPage<PriceBarRecord | OptionChainResearchRecord> {
  try {
    bounded(raw, 'sourcePage');
    const p = object(raw, 'page', ['data', 'nextCursor', 'facts', 'diagnostics']);
    const f = object(p['facts'], 'facts', [
      'dataset',
      'receivedTimestampMs',
      'adjustment',
      'consistency',
      'sourceSymbol',
      'snapshotId',
      'sessionDate',
      'sourceGeneratedTimestampMs',
      'times',
      'freshness',
      'coverage',
      'quality',
      'access',
      'requestId',
      'timestampConvention',
    ]);
    for (const field of ['times', 'freshness', 'coverage', 'quality'] as const)
      if (f[field] === null) fail('metadata.' + field);
    if (p['diagnostics'] === null) fail('diagnostics');
    const d = object(f['dataset'], 'facts.dataset', ['id', 'version']);
    textField(d['id'], 'metadata.datasetId');
    textField(d['version'], 'metadata.datasetVersion');
    if (f['sourceSymbol'] !== undefined && f['sourceSymbol'] !== binding.query.symbol)
      invalid('symbol');
    if (!Array.isArray(p['data']) || p['data'].length > limit) invalid('data', 'out_of_range');
    const bars = binding.query.kind === 'price-bars';
    if (bars)
      enumField(f['timestampConvention'], 'timestampConvention', [
        'session-label-midnight-utc',
        'session-start',
        'interval-start',
      ]);
    else if (f['timestampConvention'] !== undefined) fail('timestampConvention');
    const rows = bars
      ? p['data'].map((input: unknown) => {
          const r = object(input, 'row', [
            'bar',
            'sessionDate',
            'times',
            'source',
            'provisional',
            'revision',
            'diagnostics',
          ]);
          if (r['times'] === null) fail('row.times');
          if (r['diagnostics'] === null) fail('row.diagnostics');
          const bar = object(r['bar'], 'row.bar');
          if ('symbol' in bar) fail('row.bar.symbol');
          return {
            bar: { ...bar, symbol: binding.query.symbol },
            sessionDate: r['sessionDate'] ?? null,
            timestampConvention: f['timestampConvention'],
            times: r['times'] ?? unknownTimes,
            source: r['source'] ?? null,
            provisional: r['provisional'] ?? null,
            revision: r['revision'] ?? null,
            diagnostics: r['diagnostics'] ?? emptyDiagnostics,
          };
        })
      : p['data'];
    const times = f['times'] ?? unknownTimes;
    const page = {
      contractVersion: 2,
      binding,
      kind: binding.query.kind,
      symbol: binding.query.symbol,
      data: rows,
      nextCursor: p['nextCursor'],
      ...(bars ? { timestampConvention: f['timestampConvention'] } : {}),
      issues: [],
      provenance: {
        provider: binding.provider.id,
        dataset: d['id'],
        sourceVersion: d['version'],
        receivedAt: f['receivedTimestampMs'],
        ...(f['requestId'] === undefined ? {} : { requestId: f['requestId'] }),
        ...((times as typeof unknownTimes).observedTimestampMs === null
          ? {}
          : { asOf: (times as typeof unknownTimes).observedTimestampMs }),
      },
      metadata: {
        datasetId: d['id'],
        datasetVersion: d['version'],
        receivedTimestampMs: f['receivedTimestampMs'],
        adjustment: f['adjustment'],
        consistency: f['consistency'],
        snapshotId: f['snapshotId'] ?? null,
        sessionDate: f['sessionDate'] ?? null,
        sourceGeneratedTimestampMs: f['sourceGeneratedTimestampMs'] ?? null,
        times,
        freshness: f['freshness'] ?? {
          status: 'unknown',
          configuredDelayMs: null,
          evaluatedTimestampMs: null,
        },
        coverage: f['coverage'] ?? { status: 'unknown', start: null, end: null },
        quality: f['quality'] ?? { status: 'unknown', issues: [] },
        access: f['access'] ?? 'unknown',
        executionEligibility: 'research-only',
      },
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: p['diagnostics'] ?? emptyDiagnostics,
    };
    // Structural financial validation stays common, including missing/nonfinite scanner diagnostics.
    pageData(page);
    validateV2Page(page, limit, false);
    if (pins && !equalData(pinOf(page as unknown as DataPage<PriceBarRecord>), pins))
      invalid('metadata');
    const result = page as unknown as DataPage<PriceBarRecord | OptionChainResearchRecord>;
    (page as { issues: unknown }).issues = bars
      ? barIssues(result.data as readonly PriceBarRecord[], 0)
      : [];
    validateV2Page(page, limit);
    return freezeData(result);
  } catch (e) {
    const detail = issueOf(e);
    if (detail) responseIssue(detail, 'defineDataProvider.query');
    guardResponse(e, 'page');
  }
}
export function barIssues(rows: readonly PriceBarRecord[], pageIndex: number) {
  const issues: import('./data-types.js').ResearchBarIssue[] = [];
  rows.forEach(({ bar: b }, rowIndex) => {
    if (b.low > b.high)
      issues.push({
        pageIndex,
        rowIndex,
        rule: 'low_above_high',
        fields: ['open', 'high', 'low', 'close'],
      });
    if (b.open < b.low || b.open > b.high)
      issues.push({
        pageIndex,
        rowIndex,
        rule: 'open_outside_range',
        fields: ['open', 'low', 'high'],
      });
    if (b.close < b.low || b.close > b.high)
      issues.push({
        pageIndex,
        rowIndex,
        rule: 'close_outside_range',
        fields: ['close', 'low', 'high'],
      });
  });
  return issues;
}
function validateV2PageUnchecked(
  value: unknown,
  limit = 10000,
  checkIssues = true,
): asserts value is DataPage<PriceBarRecord | OptionChainResearchRecord> {
  pageData(value);
  const p = value as DataPage<PriceBarRecord | OptionChainResearchRecord>;
  if (p.contractVersion !== 2 || !p.binding) invalid('binding');
  bindingData(p.binding);
  if (
    p.kind !== p.binding.query.kind ||
    p.symbol !== p.binding.query.symbol ||
    p.provenance.provider !== p.binding.provider.id
  )
    invalid('binding');
  if (p.data.length > limit) invalid('data', 'out_of_range');
  if (byteSize(p) > 8 * 1024 * 1024) invalid('page', 'out_of_range');
  const q = p.binding.query;
  if (q.kind === 'price-bars') {
    enumField(
      p.timestampConvention,
      'timestampConvention',
      sessionInterval(q.interval)
        ? ['session-label-midnight-utc', 'session-start']
        : ['interval-start'],
    );
    let previousSession: string | undefined;
    for (let i = 0; i < p.data.length; i++) {
      const r = p.data[i] as PriceBarRecord;
      if (r.timestampConvention !== p.timestampConvention)
        invalid('data[].timestampConvention', 'inconsistent', i);
      if (sessionInterval(q.interval)) {
        calendarDate(r.sessionDate, 'row.sessionDate');
        if (
          r.sessionDate! < q.from ||
          r.sessionDate! > q.to ||
          (previousSession !== undefined && r.sessionDate! <= previousSession)
        )
          invalid('data[].sessionDate', 'inconsistent', i);
        previousSession = r.sessionDate!;
      } else if (
        r.bar.timestampMs < zonedInstant(q.from, 'request.from') ||
        r.bar.timestampMs > zonedInstant(q.to, 'request.to')
      )
        invalid('data[].bar.timestampMs', 'inconsistent', i);
    }
    if (checkIssues && !equalData(p.issues, barIssues(p.data as readonly PriceBarRecord[], 0)))
      invalid('issues');
  } else {
    // Existing canonical terms/filter checks, without altering financial units or incomplete terms.
    pageData(p, { ...q, limit });
    if (p.timestampConvention !== undefined || !equalData(p.issues, [])) invalid('issues');
  }
}

export function validateV2Page(
  value: unknown,
  limit = 10000,
  checkIssues = true,
): asserts value is DataPage<PriceBarRecord | OptionChainResearchRecord> {
  try {
    validateV2PageUnchecked(value, limit, checkIssues);
  } catch (error) {
    guardResponse(error, 'page');
  }
}
