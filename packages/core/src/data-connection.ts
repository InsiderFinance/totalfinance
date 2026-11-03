/** Bounded explicit research acquisition. HTTP/authentication and upstream metering belong to providers. */
import { DataError, ErrorCode, InputError, UnsupportedError, QuantError } from './errors.js';
import type {
  ConnectedData,
  DataProvider,
  DataConnectionOptions,
  PriceBarsWindowOptions,
  PriceBarsWindowRequest,
  PriceBarsWindowView,
  PriceBarsWindow,
  DataRequest,
  DataViewFor,
  DataCallOptions,
  PriceBarsView,
  OhlcvInput,
  DataPage,
  PriceBarRecord,
} from './data-types.js';
import {
  object,
  numberField,
  providerShape,
  requestData,
  capabilityData,
  pageData,
  copyFrozen,
  version,
  signalField,
  aborted,
  plain,
} from './data-validation.js';
import { dataCall, dataSignal, responseData } from './data-call.js';
import { viewEnvelope, checkedView, viewSelection, invalidView } from './data-view-validation.js';
import { dataSequence } from './data-sequence-validation.js';
import { createDataView } from './data-view.js';
const defaults = { pageSize: 1000, maxPages: 20, maxRecords: 20000 };
const hard = { pageSize: 2000, maxPages: 100, maxRecords: 100000 };
function limits(
  value: DataConnectionOptions | undefined,
  ceilings = hard,
  base = defaults,
  call = false,
) {
  const args = object(
    value === undefined ? {} : value,
    'options',
    call
      ? ['pageSize', 'maxPages', 'maxRecords', 'signal']
      : ['pageSize', 'maxPages', 'maxRecords'],
  );
  const result = { ...base };
  for (const key of ['pageSize', 'maxPages', 'maxRecords'] as const)
    if (args[key] !== undefined) {
      numberField(args[key], key, 1, ceilings[key], true);
      result[key] = args[key];
    }
  return { values: result, explicitPageSize: args['pageSize'] !== undefined };
}
function windowRequest(input: PriceBarsWindowRequest, limit: number) {
  object(input, 'request', ['symbol', 'interval', 'from', 'to']);
  const query = { ...input, kind: 'price-bars' as const, limit };
  requestData(query);
  return copyFrozen(query);
}
function windowView(window: PriceBarsWindow, views: readonly PriceBarsView[]): PriceBarsWindowView {
  let closes: readonly number[] | undefined, bars: readonly OhlcvInput[] | undefined;
  function collect(key: 'closePrices' | 'ohlcvBars'): readonly number[] | readonly OhlcvInput[] {
    const values: unknown[] = [];
    for (let pageIndex = 0; pageIndex < views.length; pageIndex++) {
      try {
        const selected = viewSelection(views[pageIndex]!, key);
        for (const value of selected)
          values.push(typeof value === 'number' ? value : Object.freeze({ ...value }));
      } catch (error) {
        if (error instanceof QuantError && error.code === ErrorCode.InputMissingField) {
          const rowIndex = error.context?.['index'] as number;
          throw new InputError('ohlcvBars: actual volume is required on every selected row.', {
            code: ErrorCode.InputMissingField,
            context: { field: 'volume', pageIndex, rowIndex, index: values.length + rowIndex },
          });
        }
        throw error;
      }
    }
    return Object.freeze(values) as readonly number[] | readonly OhlcvInput[];
  }
  return Object.freeze(
    Object.defineProperties(
      { kind: 'price-bars-window' as const, window },
      {
        closePrices: {
          get() {
            return (closes ??= collect('closePrices') as readonly number[]);
          },
        },
        ohlcvBars: {
          get() {
            return (bars ??= collect('ohlcvBars') as readonly OhlcvInput[]);
          },
        },
      },
    ),
  ) as PriceBarsWindowView;
}
/** Bind an installed provider once. Construction performs no reads; only priceBars walks a window.
 * @example
 * const marketData = connect(provider);
 * const prices = await marketData.priceBars({symbol:'SPY',interval:'1d',from:'2026-09-01',to:'2026-10-28'});
 */
export function connect(provider: DataProvider, options?: DataConnectionOptions): ConnectedData {
  providerShape(provider);
  const host = limits(options);
  const id = provider.id,
    providerVersion = provider.version,
    identity = { id, version: providerVersion };
  const query = provider.query.bind(provider),
    discovery = provider.capabilities.bind(provider);
  async function capabilities(options?: DataCallOptions) {
    const signal = dataSignal(options);
    return dataCall(signal, async () => {
      const result = await discovery(signal ? { signal } : undefined);
      return responseData(() => {
        capabilityData(result, identity);
        return copyFrozen(result);
      }, id);
    });
  }
  async function one<R extends DataRequest>(
    input: R,
    options?: DataCallOptions,
  ): Promise<DataViewFor<R>> {
    const signal = dataSignal(options);
    requestData(input);
    const request = copyFrozen(input);
    return dataCall(signal, async () => {
      const result = await query(request, signal ? { signal } : undefined);
      return responseData(() => {
        viewEnvelope(result, request, identity);
        return checkedView(result) as DataViewFor<R>;
      }, id);
    });
  }
  return Object.freeze({
    id,
    version: providerVersion,
    contractVersion: 1 as const,
    capabilities,
    query: one,
    async priceBars(
      input: PriceBarsWindowRequest,
      options?: PriceBarsWindowOptions,
    ): Promise<PriceBarsWindowView> {
      const call = limits(options, host.values, host.values, true);
      const signal = options?.signal;
      signalField(signal);
      const original = windowRequest(input, call.values.pageSize);
      aborted(signal);
      const declared = await capabilities(signal ? { signal } : undefined);
      const capability = declared.capabilities.find(
        (c) => c.kind === 'price-bars' && c.intervals.includes(original.interval),
      );
      if (!capability)
        throw new UnsupportedError(
          'priceBars: requested interval is not supported by this provider.',
          { code: ErrorCode.DataUnsupportedCapability, context: { provider: id } },
        );
      if (capability.access === 'denied')
        throw new DataError('priceBars: provider entitlement is required.', {
          code: ErrorCode.DataEntitlementRequired,
          context: { provider: id },
        });
      const pageSize =
        host.explicitPageSize || call.explicitPageSize
          ? call.values.pageSize
          : Math.min(call.values.pageSize, capability.maxPageSize);
      numberField(pageSize, 'pageSize', 1, capability.maxPageSize, true);
      const pages: DataPage<PriceBarRecord>[] = [],
        views: PriceBarsView[] = [];
      const sequence = dataSequence();
      let records = 0,
        cursor: string | null = null;
      do {
        aborted(signal);
        const limit =
          pages.length >= call.values.maxPages
            ? 'maxPages'
            : records >= call.values.maxRecords
              ? 'maxRecords'
              : null;
        if (limit)
          throw new DataError(
            'priceBars: terminal pagination exceeds the configured work budget; use explicit one-page query for manual control.',
            {
              code: ErrorCode.DataWindowBudgetExceeded,
              context: {
                provider: id,
                kind: 'price-bars',
                limit,
                pageCalls: pages.length,
                records,
                maxPages: call.values.maxPages,
                maxRecords: call.values.maxRecords,
                retryable: false,
              },
            },
          );
        const count = Math.min(pageSize, call.values.maxRecords - records);
        const request = pages.length
          ? { kind: 'price-bars' as const, symbol: original.symbol, cursor: cursor!, limit: count }
          : { ...original, limit: count };
        const view = (await one(request, signal ? { signal } : undefined)) as PriceBarsView;
        responseData(() => {
          pageData(view.page, { ...original, limit: count }, identity);
          if (view.page.metadata.consistency !== capability.consistency) invalidView();
          sequence(view.page);
        }, id);
        pages.push(view.page);
        views.push(view);
        records += view.page.data.length;
        cursor = view.page.nextCursor;
      } while (cursor !== null);
      aborted(signal);
      const request: PriceBarsWindowRequest = Object.freeze({
        symbol: original.symbol,
        interval: original.interval,
        from: original.from,
        to: original.to,
      });
      const window: PriceBarsWindow = Object.freeze({
        version: 1,
        kind: 'price-bars-window',
        request,
        pages: Object.freeze(pages),
        pagination: Object.freeze({
          status: 'terminal',
          pageSize,
          pageCalls: pages.length,
          records,
        }),
      });
      return windowView(window, views);
    },
  });
}
/** Restore retained research pages, never fetch or synthesize aggregate source metadata.
 * @example
 * const prices = createPriceBarsWindowView(JSON.parse(savedWindowJson));
 */
export function createPriceBarsWindowView(input: unknown): PriceBarsWindowView {
  return responseData(() => {
    plain(input);
    const args = object(input, 'window', ['version', 'kind', 'request', 'pages', 'pagination']);
    version(args['version']);
    if (args['kind'] !== 'price-bars-window') invalidView();
    const pagination = object(args['pagination'], 'pagination', [
      'status',
      'pageSize',
      'pageCalls',
      'records',
    ]);
    if (pagination['status'] !== 'terminal') invalidView();
    numberField(pagination['pageSize'], 'pageSize', 1, 2000, true);
    numberField(pagination['pageCalls'], 'pageCalls', 1, 100, true);
    numberField(pagination['records'], 'records', 0, 100000, true);
    const original = windowRequest(
      args['request'] as PriceBarsWindowRequest,
      pagination['pageSize'],
    );
    if (!Array.isArray(args['pages']) || args['pages'].length !== pagination['pageCalls'])
      invalidView();
    const views: PriceBarsView[] = [],
      sequence = dataSequence();
    let records = 0;
    for (let i = 0; i < args['pages'].length; i++) {
      const p = args['pages'][i];
      pageData(p, original);
      if ((p.nextCursor === null) !== (i === args['pages'].length - 1)) invalidView();
      sequence(p);
      records += p.data.length;
      views.push(createDataView(p) as PriceBarsView);
    }
    if (records !== pagination['records']) invalidView();
    const window = copyFrozen(input) as PriceBarsWindow;
    return windowView(window, views);
  });
}
