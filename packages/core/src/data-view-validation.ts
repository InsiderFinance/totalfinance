/** Conformance validates actual supplied selectors; it never repairs an incorrect provider view. */
import { responseIssue } from './data-response-issue.js';
import { ErrorCode, QuantError } from './errors.js';
import type { DataProvider, DataQuery, DataView, OhlcvInput } from './data-types.js';
import { pageData, plain, frozen } from './data-validation.js';
import { validateV2Page, equalData, barIssues, continuationOf } from './data-protocol.js';
export function invalidView(): never {
  responseIssue(
    {
      phase: 'view',
      path: 'view',
      reason: 'invalid_structure',
      validationCode: ErrorCode.DataInvalidResponse,
    },
    'query',
  );
}
export function viewEnvelope(
  value: unknown,
  request?: DataQuery,
  provider?: Pick<DataProvider, 'id' | 'version'>,
): asserts value is DataView {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  )
    invalidView();
  const d = Object.getOwnPropertyDescriptors(value);
  for (const k of ['kind', 'page', 'continuation', 'continuationStatus'])
    if (!d[k] || !('value' in d[k]!) || !d[k]!.enumerable || d[k]!.writable || d[k]!.configurable)
      invalidView();
  const p = d['page']!.value;
  pageData(p);
  if (p.contractVersion === 2) validateV2Page(p);
  if (!frozen(p) || d['kind']!.value !== p.kind) invalidView();
  if (
    (request && !equalData(p.binding?.query, request)) ||
    (provider && !equalData(p.binding?.provider, provider))
  )
    invalidView();
  if (
    !equalData(d['continuation']!.value, continuationOf(p)) ||
    d['continuationStatus']!.value !==
      (p.nextCursor === null
        ? 'terminal'
        : p.contractVersion === 2
          ? 'available'
          : 'unavailable-legacy-context')
  )
    invalidView();
  if (p.kind === 'price-bars')
    for (const k of ['closePrices', 'ohlcvBars', 'bars'])
      if (
        !d[k] ||
        typeof d[k]!.get !== 'function' ||
        d[k]!.set ||
        d[k]!.enumerable ||
        d[k]!.configurable
      )
        invalidView();
}
export function viewSelection(
  view: DataView,
  key: 'closePrices' | 'ohlcvBars' | 'bars',
): readonly unknown[] | undefined {
  if (view.kind !== 'price-bars') invalidView();
  const missing =
    key !== 'closePrices' ? view.page.data.findIndex((r) => r.bar.volume === undefined) : -1;
  if (view.selection.decisions.length) invalidView();
  const used = key === 'closePrices' ? ['close'] : ['open', 'high', 'low', 'close'];
  const suspect = barIssues(view.page.data, 0).find((i) => i.fields.some((f) => used.includes(f)));
  let value: unknown;
  try {
    value = view[key];
  } catch (error) {
    if (
      error instanceof QuantError &&
      suspect &&
      error.code === ErrorCode.DataSuspectObservations &&
      equalData(error.context, { ...suspect, selection: key })
    )
      return undefined;
    if (
      error instanceof QuantError &&
      !suspect &&
      missing !== -1 &&
      error.code === ErrorCode.InputMissingField &&
      equalData(error.context, { field: 'volume', pageIndex: 0, rowIndex: missing, index: missing })
    )
      return undefined;
    invalidView();
  }
  if (suspect || missing !== -1) invalidView();
  plain(value);
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !frozen(value) ||
    view[key] !== value
  )
    invalidView();
  // Kit probes start without caller research decisions. Check every source row independently.
  if (view.selection.decisions.length || value.length !== view.page.data.length) invalidView();
  for (let i = 0; i < value.length; i++) {
    const b = view.page.data[i]!.bar;
    if (key === 'closePrices') {
      if (value[i] !== b.close) invalidView();
    } else {
      const r = value[i] as Record<string, unknown>;
      const expected =
        key === 'bars'
          ? {
              symbol: b.symbol,
              timestampMs: b.timestampMs,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              ...(b.adjusted === undefined ? {} : { adjusted: b.adjusted }),
              ...(b.vwap === undefined ? {} : { vwap: b.vwap }),
            }
          : { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      if (!equalData(r, expected)) invalidView();
    }
  }
  return value;
}
