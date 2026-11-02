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
    const c = await provider.capabilities({});
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
        provider.query({ request: probe.request as DataRequest }),
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
      provider.query({ request: probe.request, signal: pre.signal }),
    );
    if (probe.kind === 'abort') {
      const controller = new AbortController();
      const query = Promise.resolve().then(() =>
        provider.query({ request: probe.request, signal: controller.signal }),
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
        const value = await provider.query({ request: sent });
        pageData(value, request, provider);
        return value;
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
