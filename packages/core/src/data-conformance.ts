/** Framework-independent, bounded behavioral proof using caller-supplied synthetic facts. */
import { ErrorCode, DataError, QuantError } from './errors.js';
import { canonicalJsonOf } from './canonical-json.js';
import type {
  DataProvider,
  DataPage,
  DataRequest,
  PriceBarRecord,
  OptionChainResearchRecord,
} from './data-types.js';
import {
  object,
  textField,
  numberField,
  enumField,
  fail,
  providerShape,
  requestData,
  capabilityData,
  pageData,
  copyFrozen,
  frozen,
  plain,
  rowKey,
  compareKeys,
} from './data-validation.js';

/** Exact expected pages, with receipt clocks and opaque cursor constants pinned by the test host. */
export interface DataPagesProbe {
  readonly name: string;
  readonly kind: 'pages';
  readonly request: DataRequest;
  readonly expectedPages: readonly DataPage<PriceBarRecord | OptionChainResearchRecord>[];
}
/** A refused call, including deliberately malformed caller input. */
export interface DataErrorProbe {
  readonly name: string;
  readonly kind: 'error';
  readonly request: unknown;
  readonly expectedCode: string;
}
/** In-flight abort; the host supplies only a started latch, never a substitute query result. */
export interface DataAbortProbe {
  readonly name: string;
  readonly kind: 'abort';
  readonly request: DataRequest;
  readonly waitUntilStarted: () => Promise<void>;
}
export type DataProviderProbe = DataPagesProbe | DataErrorProbe | DataAbortProbe;
/** Work bounds are verification limits, never financial-time assumptions. */
export interface ValidateDataProviderInput {
  readonly provider: DataProvider;
  readonly probes: readonly DataProviderProbe[];
  readonly maxPages: number;
  readonly maxRecords: number;
  readonly timeoutMs: number;
}

/** Verify the provider directly. Never wraps, repairs, fetches fixtures or discovers credentials.
 * Resolves only when every supplied law passes; malformed fixtures use input errors, provider
 * failures use data.nonconformant with a safe probe/law context. */
export async function validateDataProvider(input: ValidateDataProviderInput): Promise<void> {
  const args = object(input, 'input', [
    'provider',
    'probes',
    'maxPages',
    'maxRecords',
    'timeoutMs',
  ]);
  providerShape(args['provider']);
  const provider = args['provider'];
  numberField(args['maxPages'], 'maxPages', 1, 100, true);
  numberField(args['maxRecords'], 'maxRecords', 1, 100000, true);
  numberField(args['timeoutMs'], 'timeoutMs', 1, 30000, true);
  const maxPages = args['maxPages'],
    maxRecords = args['maxRecords'],
    timeoutMs = args['timeoutMs'];
  if (!Array.isArray(args['probes']) || !args['probes'].length) fail('probes');
  const probes = args['probes'] as DataProviderProbe[];
  const names = new Set();
  for (const probe of probes) {
    const p = object(probe, 'probe');
    textField(p['name'], 'probe.name');
    if (names.has(p['name'])) fail('probe.name');
    names.add(p['name']);
    enumField(p['kind'], 'probe.kind', ['pages', 'error', 'abort']);
    object(
      probe,
      'probe',
      p['kind'] === 'pages'
        ? ['name', 'kind', 'request', 'expectedPages']
        : p['kind'] === 'error'
          ? ['name', 'kind', 'request', 'expectedCode']
          : ['name', 'kind', 'request', 'waitUntilStarted'],
    );
    if (probe.kind === 'error') {
      if (!(Object.values(ErrorCode) as string[]).includes(probe.expectedCode))
        fail('probe.expectedCode');
    } else {
      requestData(probe.request);
      if ('cursor' in probe.request && probe.kind === 'pages') fail('probe.request');
    }
    if (probe.kind === 'pages') {
      if (!Array.isArray(probe.expectedPages) || !probe.expectedPages.length)
        fail('probe.expectedPages');
      for (const page of probe.expectedPages) pageData(page, probe.request, provider);
    }
    if (probe.kind === 'abort' && typeof probe.waitUntilStarted !== 'function')
      fail('probe.waitUntilStarted');
  }
  function violation(probe: string, law: string): never {
    throw new DataError(
      `validateDataProvider: ${probe} failed ${law}; fix the provider or its capability claim.`,
      { code: ErrorCode.DataNonconformant, context: { provider: provider.id, probe, law } },
    );
  }
  function viewFacts(
    view: unknown,
    raw: DataPage<PriceBarRecord | OptionChainResearchRecord>,
    probe: string,
  ): void {
    const v = object(view, 'view');
    if (
      Object.getPrototypeOf(view) !== Object.prototype ||
      !Object.isFrozen(view) ||
      v['kind'] !== raw.kind
    )
      violation(probe, 'immutable view kind');
    const fields =
      raw.kind === 'price-bars' ? ['kind', 'page', 'closePrices', 'ohlcvBars'] : ['kind', 'page'];
    if (
      Reflect.ownKeys(v).length !== fields.length ||
      Reflect.ownKeys(v).some((k) => typeof k !== 'string' || !fields.includes(k))
    )
      violation(probe, 'view fields');
    for (const key of ['kind', 'page']) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !('value' in d) || !d.enumerable || d.writable || d.configurable)
        violation(probe, 'view source descriptor');
    }
    if (JSON.stringify(v) !== JSON.stringify({ kind: raw.kind, page: raw }))
      violation(probe, 'view serialization');
    if (raw.kind !== 'price-bars') return;
    for (const key of ['closePrices', 'ohlcvBars']) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (
        !d ||
        typeof d.get !== 'function' ||
        d.set !== undefined ||
        d.enumerable ||
        d.configurable
      )
        violation(probe, 'lazy view selection');
    }
    const rows = raw.data as readonly PriceBarRecord[];
    function selected(value: unknown, expected: unknown, key: string): void {
      plain(value);
      if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        !frozen(value)
      )
        violation(probe, key + ' native immutable array');
      if (
        Reflect.ownKeys(value).length !== rows.length + 1 ||
        Reflect.ownKeys(value).some(
          (k) => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k)),
        )
      )
        violation(probe, key + ' array fields');
      if (canonicalJsonOf(value) !== canonicalJsonOf(expected))
        violation(probe, key + ' correspondence');
    }
    const closes = v['closePrices'];
    selected(
      closes,
      rows.map((row) => row.bar.close),
      'closePrices',
    );
    if (v['closePrices'] !== closes) violation(probe, 'stable closePrices');
    const missing = rows.findIndex((row) => row.bar.volume === undefined);
    if (missing !== -1) {
      let error: unknown;
      try {
        void v['ohlcvBars'];
      } catch (caught) {
        error = caught;
      }
      if (
        !(error instanceof QuantError) ||
        error.code !== ErrorCode.InputMissingField ||
        error.context?.['field'] !== 'volume' ||
        error.context?.['index'] !== missing
      )
        violation(probe, 'missing OHLCV volume');
    } else {
      const bars = v['ohlcvBars'];
      selected(
        bars,
        rows.map(({ bar: { open, high, low, close, volume } }) => ({
          open,
          high,
          low,
          close,
          volume,
        })),
        'ohlcvBars',
      );
      if (v['ohlcvBars'] !== bars) violation(probe, 'stable ohlcvBars');
    }
  }
  async function bounded<T>(probe: string, law: string, operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DataError('validateDataProvider: verification time limit exceeded.', {
                  code: ErrorCode.DataNonconformant,
                }),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      violation(probe, law);
    } finally {
      clearTimeout(timer);
    }
  }
  async function refuses(
    probe: string,
    code: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    const outcome = await bounded(probe, 'typed refusal', async () => {
      try {
        await operation();
        return null;
      } catch (error) {
        return error;
      }
    });
    if (!(outcome instanceof QuantError) || outcome.code !== code)
      violation(probe, 'typed refusal');
  }
  const capabilities = await bounded('discovery', 'capability grammar', async () => {
    const c = await provider.capabilities();
    capabilityData(c, provider);
    if (!frozen(c)) violation('discovery', 'immutable capabilities');
    return c;
  });
  const pre = new AbortController();
  pre.abort();
  await refuses('discovery pre-abort', ErrorCode.DataAborted, () =>
    provider.capabilities({ signal: pre.signal }),
  );
  const exercised = new Set();
  for (const probe of probes) {
    if (probe.kind === 'error') {
      await refuses(probe.name, probe.expectedCode, () =>
        provider.query(probe.request as DataRequest),
      );
      continue;
    }
    const capability = capabilities.capabilities.find((c) => c.kind === probe.request.kind);
    if (
      !capability ||
      probe.request.limit > capability.maxPageSize ||
      (!('cursor' in probe.request) &&
        probe.request.kind === 'price-bars' &&
        !capability.intervals.includes(probe.request.interval))
    )
      violation(probe.name, 'capability truthfulness');
    await refuses(probe.name + ' pre-abort', ErrorCode.DataAborted, () =>
      provider.query(probe.request, { signal: pre.signal }),
    );
    if (probe.kind === 'abort') {
      const controller = new AbortController();
      const query = Promise.resolve().then(() =>
        provider.query(probe.request, { signal: controller.signal }),
      );
      const outcome = query.then(
        () => null,
        (error) => error as unknown,
      );
      try {
        await bounded(probe.name, 'started latch', probe.waitUntilStarted);
      } finally {
        controller.abort();
      }
      await refuses(probe.name, ErrorCode.DataAborted, async () => {
        const result = await outcome;
        if (result !== null) throw result;
      });
      continue;
    }
    exercised.add(probe.request.kind);
    let request: DataRequest = copyFrozen(probe.request),
      records = 0;
    let previous: readonly (string | number)[] | undefined;
    const identities = new Set();
    const cursors = new Set();
    let snapshot: string | null | undefined;
    let dataset: string | undefined;
    let datasetVersion: string | undefined;
    if (probe.expectedPages.length > maxPages) violation(probe.name, 'maxPages');
    for (let index = 0; index < probe.expectedPages.length; index++) {
      const sent = JSON.parse(canonicalJsonOf(request)) as DataRequest;
      const before = canonicalJsonOf(sent);
      const page = await bounded(probe.name, 'page grammar', async () => {
        const view = await provider.query(sent);
        const value = object(view, 'view');
        pageData(value['page'], request, provider);
        const raw = value['page'];
        viewFacts(view, raw, probe.name);
        return raw;
      });
      if (canonicalJsonOf(sent) !== before) violation(probe.name, 'input immutability');
      if (!frozen(page)) violation(probe.name, 'immutable page');
      if (
        page.data.length > capability.maxPageSize ||
        page.metadata.consistency !== capability.consistency
      )
        violation(probe.name, 'capability truthfulness');
      if (
        index &&
        (page.metadata.snapshotId !== snapshot ||
          page.metadata.datasetId !== dataset ||
          page.metadata.datasetVersion !== datasetVersion)
      )
        violation(probe.name, 'snapshot identity');
      snapshot = page.metadata.snapshotId;
      dataset = page.metadata.datasetId;
      datasetVersion = page.metadata.datasetVersion;
      for (const row of page.data) {
        const key = rowKey(page.kind, row);
        if (previous && compareKeys(previous, key) >= 0) violation(probe.name, 'cross-page order');
        previous = key;
        const identity =
          page.kind === 'price-bars'
            ? String(key[0])
            : (row as OptionChainResearchRecord).sourceContractId;
        if (identities.has(identity)) violation(probe.name, 'cross-page identity');
        identities.add(identity);
      }
      records += page.data.length;
      if (records > maxRecords) violation(probe.name, 'maxRecords');
      if (canonicalJsonOf(page) !== canonicalJsonOf(probe.expectedPages[index]))
        violation(probe.name, 'expected facts');
      if (page.nextCursor === null) {
        if (index !== probe.expectedPages.length - 1)
          violation(probe.name, 'premature terminal page');
      } else {
        if (index === probe.expectedPages.length - 1 || cursors.has(page.nextCursor))
          violation(probe.name, 'bounded cursor walk');
        cursors.add(page.nextCursor);
        request = {
          kind: request.kind,
          symbol: request.symbol,
          cursor: page.nextCursor,
          limit: request.limit,
        };
      }
    }
  }
  for (const capability of capabilities.capabilities)
    if (!exercised.has(capability.kind)) violation('probes', 'unproved capability');
}
