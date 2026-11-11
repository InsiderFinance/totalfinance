import { responseIssue } from './data-response-issue.js';
/** Shared read-door checks. Never repairs a provider's source page or selected values. */
import { ErrorCode, InputError, QuantError } from './errors.js';
import type { DataProvider, DataRequest, DataView, OhlcvInput } from './data-types.js';
import { pageData, plain, frozen } from './data-validation.js';

export function invalidView(): never {
  responseIssue(
    {
      phase: 'view',
      path: 'view',
      reason: 'invalid_structure',
      validationCode: ErrorCode.DataInvalidResponse,
    },
    'connect',
  );
}
/** Check descriptors before reading source fields; no selector is invoked here. */
export function viewEnvelope(
  value: unknown,
  request?: DataRequest,
  provider?: Pick<DataProvider, 'id' | 'version'>,
): asserts value is DataView {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  )
    invalidView();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of ['kind', 'page']) {
    const d = descriptors[name];
    if (!d || !('value' in d) || !d.enumerable || d.writable || d.configurable) invalidView();
  }
  const raw = descriptors['page']!.value;
  pageData(raw, request, provider);
  if (!frozen(raw) || descriptors['kind']!.value !== raw.kind) invalidView();
  const keys =
    raw.kind === 'price-bars' ? ['kind', 'page', 'closePrices', 'ohlcvBars'] : ['kind', 'page'];
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((k) => typeof k !== 'string' || !keys.includes(k))
  )
    invalidView();
  if (raw.kind === 'price-bars')
    for (const name of ['closePrices', 'ohlcvBars']) {
      const d = descriptors[name];
      if (
        !d ||
        typeof d.get !== 'function' ||
        d.set !== undefined ||
        d.enumerable ||
        d.configurable
      )
        invalidView();
    }
}
/** Compare the actual selector with every retained row; do not manufacture a correct replacement. */
export function viewSelection(
  view: DataView,
  key: 'closePrices' | 'ohlcvBars',
): readonly number[] | readonly OhlcvInput[] {
  if (view.kind !== 'price-bars') invalidView();
  const rows = view.page.data;
  const missing = key === 'ohlcvBars' ? rows.findIndex((row) => row.bar.volume === undefined) : -1;
  let value: readonly number[] | readonly OhlcvInput[];
  try {
    value = view[key];
  } catch (error) {
    if (
      missing !== -1 &&
      error instanceof QuantError &&
      error.code === ErrorCode.InputMissingField &&
      error.context?.['field'] === 'volume' &&
      error.context?.['index'] === missing
    ) {
      throw new InputError('ohlcvBars: actual volume is required on every selected row.', {
        code: ErrorCode.InputMissingField,
        context: { field: 'volume', index: missing },
      });
    }
    invalidView();
  }
  if (missing !== -1) invalidView();
  try {
    plain(value);
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      !frozen(value) ||
      value.length !== rows.length ||
      view[key] !== value
    )
      invalidView();
    for (let i = 0; i < rows.length; i++) {
      const bar = rows[i]!.bar;
      if (key === 'closePrices') {
        if (value[i] !== bar.close) invalidView();
      } else {
        const row = value[i] as OhlcvInput;
        if (
          !row ||
          typeof row !== 'object' ||
          Object.getPrototypeOf(row) !== Object.prototype ||
          Object.keys(row).length !== 5
        )
          invalidView();
        for (const field of ['open', 'high', 'low', 'close', 'volume'] as const)
          if (row[field] !== bar[field]) invalidView();
      }
    }
    return value;
  } catch {
    invalidView();
  }
}
/** Delegate selectors lazily; SDK outputs are fresh ordinary frozen native arrays. */
export function checkedView(view: DataView): DataView {
  if (view.kind !== 'price-bars') return view;
  let closes: readonly number[] | undefined, bars: readonly OhlcvInput[] | undefined;
  return Object.freeze(
    Object.defineProperties(
      { kind: 'price-bars' as const, page: view.page },
      {
        closePrices: {
          get() {
            return (closes ??= Object.freeze(
              Array.from(viewSelection(view, 'closePrices') as readonly number[]),
            ));
          },
        },
        ohlcvBars: {
          get() {
            return (bars ??= Object.freeze(
              Array.from(viewSelection(view, 'ohlcvBars') as readonly OhlcvInput[], (row) =>
                Object.freeze({ ...row }),
              ),
            ));
          },
        },
      },
    ),
  ) as DataView;
}
