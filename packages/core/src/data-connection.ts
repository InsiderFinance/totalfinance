/** Bounded terminal research acquisition and explicit private, consumed-work checkpoints. */
import { issueOf, responseError } from './data-response-issue.js';
import { ErrorCode, InputError, DataError, QuantError, UnsupportedError } from './errors.js';
import { object, numberField, enumField, signalField, aborted, fail } from './data-validation.js';
import {
  sourceShape,
  queryData,
  bindingData,
  freezeData,
  equalData,
  bounded,
  byteSize,
  validateV2Page,
  checkCapability,
  continuationOf,
} from './data-protocol.js';
import { defineDataProvider } from './data-provider.js';
import { dataSequence } from './data-sequence-validation.js';
import { makeWindowView } from './data-window-view.js';
import { legacyWindowView } from './data-legacy-window.js';
import type {
  DataProviderSource,
  ConnectedData,
  DataConnectionOptions,
  PriceBarsWindowOptions,
  PriceBarsWindowRequest,
  PriceBarsWindowView,
  PriceBarsWindow,
  PriceBarsCheckpoint,
  DataQueryBinding,
  PriceBarRecord,
  DataPage,
  DataCapability,
  PriceBarsQuery,
} from './data-types.js';
// Resolve these registered values outside guarded phases. Reading the shared enum object
// inside a catch-observable phase conservatively retains its full catalog in Rollup.
const inputRangeCode = ErrorCode.InputOutOfRange;
const unsupportedCapabilityCode = ErrorCode.DataUnsupportedCapability;
const invalidResponseCode = ErrorCode.DataInvalidResponse;
const defaults = { pageSize: 1000, maxPages: 20, maxReads: 21, maxRecords: 20000 };
const hard = { pageSize: 10000, maxPages: 100, maxReads: 101, maxRecords: 100000 };
const keys = ['maxPages', 'maxReads', 'maxRecords'] as const;
function controls(value: unknown, ceiling = hard, base = defaults, call = false) {
  const o = object(
    value === undefined ? {} : value,
    'options',
    call ? ['pageSize', ...keys, 'signal'] : ['pageSize', ...keys],
  );
  const values = { ...base };
  for (const k of ['pageSize', ...keys] as const)
    if (o[k] !== undefined) {
      numberField(o[k], k, 1, ceiling[k], true);
      values[k] = o[k];
    }
  if (call) signalField(o['signal']);
  return { values, explicit: Object.freeze({ ...o }) };
}
function query(input: PriceBarsWindowRequest): PriceBarsQuery {
  object(input, 'request', ['symbol', 'interval', 'from', 'to']);
  const q = { ...input, kind: 'price-bars' as const };
  queryData(q);
  return freezeData(q);
}
function budget(checkpoint: PriceBarsCheckpoint, dimension?: string): never {
  const limit =
    dimension ??
    (checkpoint.progress.acceptedPages >= checkpoint.limits.maxPages
      ? 'maxPages'
      : checkpoint.progress.records >= checkpoint.limits.maxRecords
        ? 'maxRecords'
        : 'maxReads');
  throw new DataError(
    'priceBars: terminal paging requires an explicit increase of the host work budget.',
    {
      code: ErrorCode.DataWindowBudgetExceeded,
      context: {
        provider: checkpoint.binding.provider.id,
        kind: 'price-bars',
        limit,
        retryable: false,
        reads: checkpoint.progress.reads,
        pageCalls: checkpoint.progress.acceptedPages,
        records: checkpoint.progress.records,
        ...checkpoint.limits,
      },
    },
  );
}

function attach(error: unknown, checkpoint: PriceBarsCheckpoint): never {
  if (error && typeof error === 'object')
    Object.defineProperty(error, 'checkpoint', {
      value: freezeData(checkpoint),
      enumerable: false,
    });
  throw error;
}
function pagesState(
  pages: readonly DataPage<PriceBarRecord>[],
  binding: DataQueryBinding,
  terminal: boolean,
) {
  const sequence = dataSequence();
  let records = 0,
    bytes = 0;
  if (pages.length > 100) fail('pages');
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    try {
      validateV2Page(p);
    } catch (error) {
      const detail = issueOf(error);
      if (detail) throw responseError({ ...detail, pageIndex: i }, 'createPriceBarsWindowView');
      throw error;
    }
    if (p.kind !== 'price-bars' || !equalData(p.binding, binding)) fail('binding');
    if ((p.nextCursor === null) !== (terminal && i === pages.length - 1)) fail('pages.nextCursor');
    sequence(p);
    records += p.data.length;
    bytes += byteSize(p);
    if (records > hard.maxRecords || bytes > 64 * 1024 * 1024) fail('pages', inputRangeCode);
  }
  return { records, bytes };
}
function checkpointDataUnchecked(value: unknown): PriceBarsCheckpoint {
  bounded(value, 'checkpoint', 20_000_000);
  const c = object(value, 'checkpoint', [
    'version',
    'kind',
    'contractVersion',
    'binding',
    'pages',
    'next',
    'progress',
    'paging',
    'limits',
    'bytes',
  ]);
  enumField(c['version'], 'checkpoint.version', [1]);
  enumField(c['kind'], 'checkpoint.kind', ['price-bars-checkpoint']);
  enumField(c['contractVersion'], 'checkpoint.contractVersion', [2]);
  bindingData(c['binding']);
  const binding = c['binding'];
  if (binding.query.kind !== 'price-bars') fail('binding.query.kind');
  if (!Array.isArray(c['pages'])) fail('pages');
  const pages = c['pages'] as DataPage<PriceBarRecord>[];
  const state = pagesState(pages, binding, false);
  const limits = object(c['limits'], 'limits', keys);
  for (const k of keys) numberField(limits[k], 'limits.' + k, 1, hard[k], true);
  const progress = object(c['progress'], 'progress', [
    'status',
    'acceptedPages',
    'records',
    'reads',
  ]);
  enumField(progress['status'], 'progress.status', ['incomplete']);
  numberField(progress['acceptedPages'], 'progress.acceptedPages', 0, 100, true);
  numberField(progress['records'], 'progress.records', 0, 100000, true);
  numberField(progress['reads'], 'progress.reads', 0, 101, true);
  if (
    progress['acceptedPages'] !== pages.length ||
    progress['records'] !== state.records ||
    progress['reads'] < (pages.length ? pages.length + 1 : 0) ||
    progress['acceptedPages'] > (limits['maxPages'] as number) ||
    progress['records'] > (limits['maxRecords'] as number) ||
    progress['reads'] > (limits['maxReads'] as number)
  )
    fail('progress');
  numberField(c['bytes'], 'bytes', 0, 64 * 1024 * 1024, true);
  if (c['bytes'] !== state.bytes) fail('bytes');
  if (!equalData(c['next'], pages.length ? continuationOf(pages[pages.length - 1]!) : null))
    fail('next');
  const paging = object(c['paging'], 'paging', ['requested', 'state']),
    r = object(paging['requested'], 'paging.requested'),
    s = object(paging['state'], 'paging.state');
  enumField(r['mode'], 'paging.requested.mode', ['automatic', 'explicit']);
  object(r, 'paging.requested', r['mode'] === 'automatic' ? ['mode'] : ['mode', 'size']);
  if (r['mode'] === 'explicit') numberField(r['size'], 'paging.requested.size', 1, 10000, true);
  enumField(s['status'], 'paging.state.status', ['unresolved', 'resolved']);
  object(s, 'paging.state', s['status'] === 'resolved' ? ['status', 'effectiveSize'] : ['status']);
  if (s['status'] === 'resolved') {
    numberField(s['effectiveSize'], 'paging.state.effectiveSize', 1, 10000, true);
    if (
      (r['mode'] === 'explicit' && s['effectiveSize'] !== r['size']) ||
      (r['mode'] === 'automatic' && s['effectiveSize'] > 1000)
    )
      fail('paging');
    for (const p of pages) if (p.data.length > s['effectiveSize']) fail('paging');
  } else if (pages.length) fail('paging.state');
  return freezeData(c as unknown as PriceBarsCheckpoint);
}
function checkpointData(value: unknown): PriceBarsCheckpoint {
  try {
    return checkpointDataUnchecked(value);
  } catch (error) {
    const d = issueOf(error);
    if (d)
      throw new InputError('resumePriceBars: malformed checkpoint input.', {
        code: d.validationCode.startsWith('input.') ? d.validationCode : ErrorCode.InputWrongShape,
        context: { ...d, field: 'checkpoint' },
      });
    throw error;
  }
}
/** Explicit accessor; serialized public errors never contain licensed pages or cursors. */
export function priceBarsCheckpoint(error: unknown): PriceBarsCheckpoint | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const d = Object.getOwnPropertyDescriptor(error, 'checkpoint');
  if (!d) return undefined;
  if (!('value' in d)) fail('checkpoint');
  return checkpointData(d.value);
}
/** Bind only protocol2 sources. Construction performs no discovery or network work. */
export function connect(
  source: DataProviderSource,
  options?: DataConnectionOptions,
): ConnectedData {
  sourceShape(source);
  const host = controls(options),
    provider = defineDataProvider(source),
    bindingProvider = freezeData({ id: source.id, version: source.version });
  const sourceQuery = source.query.bind(source),
    sourceCapabilities = source.capabilities.bind(source);
  async function walk(
    binding: DataQueryBinding,
    options: PriceBarsWindowOptions | undefined,
    saved?: PriceBarsCheckpoint,
  ): Promise<PriceBarsWindowView> {
    let call: ReturnType<typeof controls>;
    try {
      call = controls(options, host.values, host.values, true);
    } catch (error) {
      if (saved) attach(error, saved);
      throw error;
    }
    const signal = options?.signal;
    let cp: PriceBarsCheckpoint =
      saved ??
      freezeData({
        version: 1,
        kind: 'price-bars-checkpoint',
        contractVersion: 2,
        binding,
        pages: [],
        next: null,
        progress: { status: 'incomplete', acceptedPages: 0, records: 0, reads: 0 },
        paging: {
          requested:
            call.explicit['pageSize'] !== undefined || host.explicit['pageSize'] !== undefined
              ? { mode: 'explicit', size: call.values.pageSize }
              : { mode: 'automatic' },
          state: { status: 'unresolved' },
        },
        limits: {
          maxPages: call.values.maxPages,
          maxReads: call.values.maxReads,
          maxRecords: call.values.maxRecords,
        },
        bytes: 0,
      });
    function update(changes: Partial<PriceBarsCheckpoint>) {
      cp = freezeData({ ...cp, ...changes });
    }
    function room() {
      if (
        cp.progress.reads + 2 > cp.limits.maxReads ||
        cp.progress.acceptedPages >= cp.limits.maxPages ||
        cp.progress.records >= cp.limits.maxRecords
      )
        budget(cp);
    }
    // Count exactly at source method invocation, after every pre-dispatch signal check.
    let countedReads = cp.progress.reads;
    const metered: DataProviderSource = {
      protocol: 'totalfinance-data-source',
      contractVersion: 2,
      id: bindingProvider.id,
      version: bindingProvider.version,
      capabilities(o) {
        aborted(signal);
        countedReads++;
        return sourceCapabilities(o);
      },
      query(q, o) {
        aborted(signal);
        countedReads++;
        return sourceQuery(q, o);
      },
    };
    const bound = defineDataProvider(metered);
    function failed(error: unknown): never {
      update({ progress: { ...cp.progress, reads: countedReads } });
      const detail = issueOf(error);
      attach(
        detail
          ? responseError(
              { ...detail, pageIndex: detail.pageIndex ?? cp.pages.length },
              'priceBars',
            )
          : error,
        cp,
      );
    }
    async function read<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (error) {
        failed(error);
      }
    }
    try {
      aborted(signal);
      if (saved) {
        if (!equalData(binding.provider, bindingProvider)) fail('binding.provider');
        const limits = { ...saved.limits };
        for (const k of keys) {
          const candidate = call.explicit[k] ?? host.explicit[k] ?? saved.limits[k];
          numberField(candidate, k, 1, host.values[k], true);
          if (
            candidate <
            saved.progress[
              k === 'maxReads' ? 'reads' : k === 'maxPages' ? 'acceptedPages' : 'records'
            ]
          )
            fail(k, inputRangeCode);
          limits[k] = candidate;
        }
        const requested = cp.paging.requested;
        if (
          call.explicit['pageSize'] !== undefined &&
          (requested.mode !== 'explicit' || call.explicit['pageSize'] !== requested.size)
        )
          fail('pageSize');
        if (
          (cp.paging.state.status === 'resolved' &&
            cp.paging.state.effectiveSize > host.values.pageSize) ||
          (requested.mode === 'explicit' && requested.size > host.values.pageSize)
        )
          fail('pageSize', inputRangeCode);
        update({ limits });
      }
      aborted(signal);
      room();
    } catch (error) {
      failed(error);
    }
    const declared = await read(() => bound.capabilities(signal ? { signal } : undefined));
    update({ progress: { ...cp.progress, reads: countedReads } });
    const q = binding.query as PriceBarsQuery;
    let cap: DataCapability;
    let size: number;
    try {
      const supported = declared.capabilities.find(
        (c) => c.kind === 'price-bars' && c.intervals.includes(q.interval),
      );
      if (!supported)
        throw new UnsupportedError('priceBars: requested interval is not supported by provider.', {
          code: unsupportedCapabilityCode,
        });
      cap = supported;
      try {
        checkCapability(q, cap);
        if (cp.paging.state.status === 'resolved') size = cp.paging.state.effectiveSize;
        else
          size =
            cp.paging.requested.mode === 'explicit'
              ? cp.paging.requested.size
              : Math.min(1000, host.values.pageSize, cap.maxPageSize);
        numberField(
          size,
          'pageSize',
          1,
          Math.min(host.values.pageSize, cap.maxPageSize, hard.pageSize),
          true,
        );
      } catch (error) {
        if (error instanceof InputError)
          error.message = 'priceBars: ' + error.message.replace(/^[^:]*:\s*/, '');
        throw error;
      }
      update({ paging: { ...cp.paging, state: { status: 'resolved', effectiveSize: size } } });
    } catch (error) {
      failed(error);
    }
    const sequence = dataSequence();
    for (const p of cp.pages) sequence(p);
    for (;;) {
      try {
        aborted(signal);
        if (
          countedReads >= cp.limits.maxReads ||
          cp.progress.acceptedPages >= cp.limits.maxPages ||
          cp.progress.records >= cp.limits.maxRecords
        )
          budget(cp);
      } catch (error) {
        failed(error);
      }
      const view = await read(() =>
        bound.query(q, {
          limit: Math.min(size, cp.limits.maxRecords - cp.progress.records),
          ...(cp.next ? { cursor: cp.next } : {}),
          ...(signal ? { signal } : {}),
        }),
      );
      const pages = Object.freeze([...cp.pages, view.page]),
        records = cp.progress.records + view.page.data.length,
        bytes = cp.bytes + byteSize(view.page);
      // Only the SDK's local acceptance checks are inside this boundary. Constructing the
      // immutable public view happens after them, with no provider callback or strict selector.
      try {
        aborted(signal);
        if (!cap.consistency.includes(view.page.metadata.consistency))
          throw responseError(
            {
              phase: 'sequence',
              path: 'metadata.consistency',
              reason: 'inconsistent',
              validationCode: invalidResponseCode,
              pageIndex: cp.pages.length,
            },
            'priceBars',
          );
        sequence(view.page);
        if (bytes > 64 * 1024 * 1024) budget(cp, 'maxBytes');
      } catch (error) {
        failed(error);
      }
      if (view.page.nextCursor === null)
        return makeWindowView(
          freezeData({
            version: 2,
            kind: 'price-bars-window',
            contractVersion: 2,
            binding,
            pages,
            pagination: {
              status: 'terminal',
              pageSize: size,
              pageCalls: pages.length,
              reads: countedReads,
              records,
            },
            bytes,
          }),
        );
      update({
        pages,
        next: view.continuation,
        progress: {
          status: 'incomplete',
          acceptedPages: pages.length,
          records,
          reads: countedReads,
        },
        bytes,
      });
    }
  }

  return Object.freeze({
    ...provider,
    async priceBars(input: PriceBarsWindowRequest, o?: PriceBarsWindowOptions) {
      let q: PriceBarsQuery;
      try {
        q = query(input);
        controls(o, host.values, host.values, true);
      } catch (error) {
        if (error instanceof QuantError)
          error.message = 'priceBars: ' + error.message.replace(/^[^:]*:\s*/, '');
        throw error;
      }

      return walk(freezeData({ provider: bindingProvider, query: q }), o);
    },
    async resumePriceBars(input: unknown, o?: PriceBarsWindowOptions) {
      const c = checkpointData(input);
      return walk(c.binding, o, c);
    },
  });
}
/** Restore full terminal state and explicit research choices; no source calls or clocks. */
export function createPriceBarsWindowView(
  input: unknown,
  selection?: unknown,
): PriceBarsWindowView {
  if (
    input &&
    typeof input === 'object' &&
    Object.getOwnPropertyDescriptor(input, 'version')?.value === 1
  )
    return legacyWindowView(input, selection);
  bounded(input, 'window', 20_000_000);
  const w = object(input, 'window', [
    'version',
    'kind',
    'contractVersion',
    'binding',
    'pages',
    'pagination',
    'bytes',
  ]);
  enumField(w['version'], 'window.version', [2]);
  enumField(w['kind'], 'window.kind', ['price-bars-window']);
  enumField(w['contractVersion'], 'window.contractVersion', [2]);
  bindingData(w['binding']);
  if (w['binding'].query.kind !== 'price-bars') fail('binding.query');
  if (!Array.isArray(w['pages']) || !w['pages'].length) fail('pages');
  const state = pagesState(w['pages'], w['binding'], true);
  const p = object(w['pagination'], 'pagination', [
    'status',
    'pageSize',
    'pageCalls',
    'reads',
    'records',
  ]);
  enumField(p['status'], 'pagination.status', ['terminal']);
  numberField(p['pageSize'], 'pagination.pageSize', 1, 10000, true);
  numberField(p['pageCalls'], 'pagination.pageCalls', 1, 100, true);
  numberField(p['reads'], 'pagination.reads', w['pages'].length + 1, 101, true);
  numberField(p['records'], 'pagination.records', 0, 100000, true);
  if (
    p['pageCalls'] !== w['pages'].length ||
    p['records'] !== state.records ||
    w['bytes'] !== state.bytes ||
    w['pages'].some(
      (page: DataPage<PriceBarRecord>) => page.data.length > (p['pageSize'] as number),
    )
  )
    fail('pagination');
  return makeWindowView(freezeData(input as PriceBarsWindow), selection);
}
