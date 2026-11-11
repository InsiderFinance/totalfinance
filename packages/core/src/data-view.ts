import { issueOf, responseIssue } from './data-response-issue.js';
/** SDK-owned data handoff. Native arrays are page samples; context stays on the parent view. */
import { DataError, ErrorCode, InputError, QuantError, UnsupportedError } from './errors.js';
import type {
  DataPage,
  DataView,
  PriceBarRecord,
  OptionChainResearchRecord,
  OhlcvInput,
} from './data-types.js';
import { pageData, copyFrozen, plain } from './data-validation.js';

/** @internal Construct from an owned, validated frozen raw page. No I/O, clock or eager field selection. */
export function dataViewOf(page: DataPage<PriceBarRecord | OptionChainResearchRecord>): DataView {
  if (page.kind === 'option-chain-research')
    return Object.freeze({
      kind: 'option-chain-research',
      page: page as DataPage<OptionChainResearchRecord>,
    });
  const source = page as DataPage<PriceBarRecord>;
  let closePrices: readonly number[] | undefined;
  let ohlcvBars: readonly OhlcvInput[] | undefined;
  return Object.freeze(
    Object.defineProperties(
      { kind: 'price-bars' as const, page: source },
      {
        closePrices: {
          get() {
            return (closePrices ??= Object.freeze(source.data.map((row) => row.bar.close)));
          },
        },
        ohlcvBars: {
          get() {
            if (ohlcvBars) return ohlcvBars;
            ohlcvBars = Object.freeze(
              source.data.map((row, index) => {
                const { open, high, low, close, volume } = row.bar;
                if (volume === undefined)
                  throw new InputError(
                    'ohlcvBars: volume is required for OHLCV input; select known closePrices or supply actual volume.',
                    {
                      code: ErrorCode.InputMissingField,
                      context: { field: 'volume', index },
                    },
                  );
                return Object.freeze({ open, high, low, close, volume });
              }),
            );
            return ohlcvBars;
          },
        },
      },
    ),
  ) as DataView;
}

/** Restore a validated data view from a raw research page. Persist/hash the page, not its accessors.
 * @example
 * const restored = createDataView(JSON.parse(savedPageJson));
 * if (restored.kind === 'price-bars') sma(restored.closePrices, { period: 20 });
 */
export function createDataView(page: unknown): DataView {
  try {
    plain(page);
    if (
      page !== null &&
      typeof page === 'object' &&
      'kind' in page &&
      typeof page.kind === 'string' &&
      !['price-bars', 'option-chain-research'].includes(page.kind)
    )
      throw new UnsupportedError('createDataView: unsupported research data kind.', {
        code: ErrorCode.DataUnsupportedCapability,
      });
    pageData(page);
    return dataViewOf(copyFrozen(page));
  } catch (error) {
    const detail = issueOf(error);
    if (detail) responseIssue(detail, 'createDataView');
    if (
      error instanceof QuantError &&
      (error.code === ErrorCode.DataContractVersionUnsupported ||
        error.code === ErrorCode.DataUnsupportedCapability)
    )
      throw error;
    throw new DataError(
      'createDataView: invalid research page; supply the complete normalized page and source metadata.',
      { code: ErrorCode.DataInvalidResponse },
    );
  }
}
