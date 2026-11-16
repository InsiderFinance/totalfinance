import { registeredDataRefusal } from './data-provider-error.js';
/** Public independent-oracle compatibility checks, without transport or test framework dependencies. */
import { ErrorCode, DataError, InputError } from './errors.js';
import {
  object,
  textField,
  numberField,
  enumField,
  fail,
  barData,
  chainData,
} from './data-validation.js';
import {
  queryData,
  validateV2Page,
  equalData,
  bounded,
  freezeData,
  capabilityList,
} from './data-protocol.js';
import { dataSequence } from './data-sequence-validation.js';
import { viewEnvelope, viewSelection } from './data-view-validation.js';
import { issueOf, guardResponse } from './data-response-issue.js';
import type {
  DataProvider,
  DataQuery,
  DataPage,
  PriceBarRecord,
  OptionChainResearchRecord,
  DataView,
  DataContinuation,
} from './data-types.js';
export interface DataPagesProbe {
  readonly name: string;
  readonly kind: 'pages';
  readonly request: DataQuery;
  readonly pageSize: number;
  readonly expectedPages: readonly DataPage<PriceBarRecord | OptionChainResearchRecord>[];
}
export interface DataRecordsProbe {
  readonly name: string;
  readonly kind: 'records';
  readonly request: DataQuery;
  readonly pageSize: number;
  readonly expectedRecords: readonly (PriceBarRecord | OptionChainResearchRecord)[];
  readonly expectedFacts: readonly {
    readonly datasetId: string;
    readonly datasetVersion: string;
    readonly adjustment: string;
    readonly consistency: string;
  }[];
}
export interface DataErrorProbe {
  readonly name: string;
  readonly kind: 'error';
  readonly request: unknown;
  readonly pageSize: number;
  readonly expectedCode: string;
}
export interface DataAbortProbe {
  readonly name: string;
  readonly kind: 'abort';
  readonly request: DataQuery;
  readonly pageSize: number;
  readonly waitUntilStarted: () => Promise<void>;
}
export type DataProviderProbe = DataPagesProbe | DataRecordsProbe | DataErrorProbe | DataAbortProbe;
export interface ValidateDataProviderInput {
  readonly provider: DataProvider;
  readonly probes: readonly DataProviderProbe[];
  readonly maxPages: number;
  readonly maxRecords: number;
  readonly timeoutMs: number;
}
export async function validateDataProvider(input: ValidateDataProviderInput): Promise<void> {
  const x = object(input, 'input', ['provider', 'probes', 'maxPages', 'maxRecords', 'timeoutMs']);
  const p = object(x['provider'], 'provider');
  for (const k of ['query', 'capabilities']) if (typeof p[k] !== 'function') fail('provider.' + k);
  numberField(input.maxPages, 'maxPages', 1, 100, true);
  numberField(input.maxRecords, 'maxRecords', 1, 100000, true);
  numberField(input.timeoutMs, 'timeoutMs', 1, 30000, true);
  if (!Array.isArray(input.probes) || !input.probes.length) fail('probes');
  const names = new Set<string>();
  // Complete caller expectation preflight before ANY provider method invocation.
  for (const probe of input.probes) {
    object(
      probe,
      'probe',
      probe.kind === 'pages'
        ? ['name', 'kind', 'request', 'pageSize', 'expectedPages']
        : probe.kind === 'records'
          ? ['name', 'kind', 'request', 'pageSize', 'expectedRecords', 'expectedFacts']
          : probe.kind === 'abort'
            ? ['name', 'kind', 'request', 'pageSize', 'waitUntilStarted']
            : ['name', 'kind', 'request', 'pageSize', 'expectedCode'],
    );
    textField(probe.name, 'probe.name');
    if (names.has(probe.name)) fail('probe.name');
    names.add(probe.name);
    enumField(probe.kind, 'probe.kind', ['pages', 'records', 'error', 'abort']);
    numberField(probe.pageSize, 'probe.pageSize', 1, 10000, true);
    if (probe.kind !== 'error') queryData(probe.request);
    if (probe.kind === 'pages') {
      if (!Array.isArray(probe.expectedPages) || !probe.expectedPages.length) fail('expectedPages');
      for (let pageIndex = 0; pageIndex < probe.expectedPages.length; pageIndex++)
        try {
          validateV2Page(probe.expectedPages[pageIndex]);
        } catch (e) {
          const detail = issueOf(e);
          throw new InputError('validateDataProvider: malformed expected page.', {
            code: detail?.validationCode.startsWith('input.')
              ? detail.validationCode
              : ErrorCode.InputWrongShape,
            context: { ...(detail ?? {}), field: 'probes[].expectedPages', pageIndex },
          });
        }
    } else if (probe.kind === 'records') {
      try {
        bounded({ data: probe.expectedRecords });
        bounded(probe.expectedFacts);
        if (
          !Array.isArray(probe.expectedRecords) ||
          !Array.isArray(probe.expectedFacts) ||
          !probe.expectedFacts.length
        )
          fail('expectedRecords');
        for (let rowIndex = 0; rowIndex < probe.expectedRecords.length; rowIndex++)
          try {
            if (probe.request.kind === 'price-bars')
              barData(probe.expectedRecords[rowIndex], probe.request.symbol, true);
            else chainData(probe.expectedRecords[rowIndex], probe.request.symbol);
          } catch (error) {
            guardResponse(error, 'page', { rowIndex });
          }
        for (const f of probe.expectedFacts) {
          object(f, 'expectedFacts', ['datasetId', 'datasetVersion', 'adjustment', 'consistency']);
          textField(f.datasetId, 'metadata.datasetId');
          textField(f.datasetVersion, 'metadata.datasetVersion');
          enumField(f.adjustment, 'metadata.adjustment', [
            'unknown',
            'unadjusted',
            'split',
            'split-and-dividend',
          ]);
          enumField(f.consistency, 'metadata.consistency', ['snapshot', 'best-effort']);
        }
      } catch (error) {
        const d = issueOf(error);
        throw new InputError('validateDataProvider: malformed expected records.', {
          code: d?.validationCode.startsWith('input.')
            ? d.validationCode
            : ErrorCode.InputWrongShape,
          context: { ...(d ?? {}), field: 'probes[].expectedRecords' },
        });
      }
    } else if (
      probe.kind === 'error' &&
      !Object.values(ErrorCode).includes(probe.expectedCode as never)
    )
      fail('probe.expectedCode');
    else if (probe.kind === 'abort' && typeof probe.waitUntilStarted !== 'function')
      fail('waitUntilStarted');
  }
  const provider = input.provider;
  function violation(probe: string, law: string, error?: unknown, pageIndex?: number): never {
    throw new DataError('validateDataProvider: provider failed ' + law + '.', {
      code: ErrorCode.DataNonconformant,
      context: {
        provider: provider.id,
        probe,
        law,
        ...(issueOf(error)
          ? { validation: { ...issueOf(error), ...(pageIndex === undefined ? {} : { pageIndex }) } }
          : {}),
      },
    });
  }
  async function work<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(c.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            c.abort();
            reject(
              new DataError('validateDataProvider: bounded probe timed out.', {
                code: ErrorCode.DataNonconformant,
              }),
            );
          }, input.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  const caps = await work(async (signal) => {
    try {
      const c = await provider.capabilities({ signal });
      bounded(c, 'capabilities');
      object(c, 'capabilities', [
        'contractVersion',
        'providerId',
        'providerVersion',
        'capabilities',
        'ignored',
      ]);
      const parsed = capabilityList(c.capabilities, { id: provider.id, version: provider.version });
      if (
        c.contractVersion !== 2 ||
        c.providerId !== provider.id ||
        c.providerVersion !== provider.version ||
        !equalData(c.capabilities, parsed.capabilities)
      )
        violation('capabilities', 'discovery');
      object(c.ignored, 'ignored', ['kinds', 'intervals']);
      for (const k of ['kinds', 'intervals'] as const)
        numberField(c.ignored[k], 'ignored.' + k, 0, 4096, true);
      return c;
    } catch (error) {
      violation('capabilities', 'discovery', error);
    }
  });
  for (const cap of caps.capabilities)
    if (
      !input.probes.some(
        (p) => p.kind !== 'error' && p.kind !== 'abort' && p.request.kind === cap.kind,
      )
    )
      violation('capabilities', 'unproved-capability');
  for (const probe of input.probes)
    await work(async (signal) => {
      if (probe.kind === 'error') {
        let code: string | undefined;
        try {
          await provider.query(probe.request as DataQuery, { limit: probe.pageSize, signal });
        } catch (e) {
          code = registeredDataRefusal(e)?.code;
        }
        if (code !== probe.expectedCode) violation(probe.name, 'expected-error');
        return;
      }
      if (probe.kind === 'abort') {
        const pre = new AbortController();
        pre.abort();
        try {
          await provider.query(probe.request, { limit: probe.pageSize, signal: pre.signal });
          violation(probe.name, 'pre-abort');
        } catch (e) {
          if (registeredDataRefusal(e)?.code !== ErrorCode.DataAborted)
            violation(probe.name, 'pre-abort');
        }
        const c = new AbortController(),
          pending = provider.query(probe.request, { limit: probe.pageSize, signal: c.signal });
        const observed = pending.then(
          () => false,
          (e) => registeredDataRefusal(e)?.code === ErrorCode.DataAborted,
        );
        await probe.waitUntilStarted();
        c.abort();
        if (!(await observed)) violation(probe.name, 'in-flight-abort');
        return;
      }
      const cap = caps.capabilities.find(
        (c) =>
          c.kind === probe.request.kind &&
          (probe.request.kind !== 'price-bars' || c.intervals.includes(probe.request.interval)),
      );
      if (!cap || probe.pageSize > cap.maxPageSize) violation(probe.name, 'capability');
      const q = freezeData(probe.request);
      const seq = dataSequence(),
        all: (PriceBarRecord | OptionChainResearchRecord)[] = [];
      let cursor: DataContinuation | null = null,
        pageIndex = 0,
        records = 0;
      do {
        if (pageIndex >= input.maxPages || records >= input.maxRecords)
          violation(probe.name, 'bounded-walk');
        let view: DataView;
        try {
          view = await provider.query(q, {
            limit: Math.min(probe.pageSize, input.maxRecords - records),
            ...(cursor ? { cursor } : {}),
            signal,
          });
          viewEnvelope(view, probe.request, { id: provider.id, version: provider.version });
          seq(view.page);
          if (view.kind === 'price-bars')
            for (const key of ['closePrices', 'ohlcvBars', 'bars'] as const)
              viewSelection(view, key);
        } catch (e) {
          violation(probe.name, 'response', e, pageIndex);
        }
        if (probe.kind === 'pages') {
          if (
            !probe.expectedPages[pageIndex] ||
            !equalData(view.page, probe.expectedPages[pageIndex])
          )
            violation(probe.name, 'expected-facts', undefined, pageIndex);
        } else {
          const facts = probe.expectedFacts[pageIndex];
          if (!facts) violation(probe.name, 'expected-facts', undefined, pageIndex);
          for (const k of ['datasetId', 'datasetVersion', 'adjustment', 'consistency'] as const)
            if (view.page.metadata[k] !== facts[k])
              violation(probe.name, 'expected-facts', undefined, pageIndex);
        }
        all.push(...view.page.data);
        records += view.page.data.length;
        cursor = view.continuation;
        pageIndex++;
        if ((view.page.nextCursor !== null) !== (cursor !== null))
          violation(probe.name, 'continuation');
      } while (cursor);
      if (
        (probe.kind === 'pages' && pageIndex !== probe.expectedPages.length) ||
        (probe.kind === 'records' &&
          (!equalData(all, probe.expectedRecords) || pageIndex !== probe.expectedFacts.length))
      )
        violation(probe.name, 'expected-facts');
    });
}
