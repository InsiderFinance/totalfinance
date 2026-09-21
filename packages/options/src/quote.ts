/**
 * Quote price-source selection — the boundary-guarded form of core's {@link selectQuotePrice}.
 *
 * Core's kernel trusts its inputs; this public re-export is a first-touch boundary (dx §7.1), so it
 * validates the container and the source enum before delegating:
 *   - a `null`/primitive quote would crash as a raw `TypeError` on the first property read — teach;
 *   - `source` is a meaning-changing enum (often from JSON/config): `'Mid'` must teach, not be
 *     silently read as "field absent" and return `undefined` (design law #4).
 */

import {
  type OptionQuote,
  type PriceSource,
  ensureEnum,
  ensureNonNegative,
  requireArgumentObject,
  selectQuotePrice as selectQuotePriceKernel,
} from '@totalfinance/core';

const PRICE_SOURCES = ['bid', 'ask', 'mid', 'last', 'mark'] as const;

/**
 * Resolve a single price from an option quote per the requested source. Returns `undefined` when
 * the requested fields are absent. `mid` falls back to (bid+ask)/2 when an explicit mid is missing.
 * Quote records are structural artifacts, so venue/provenance fields and declared subtypes may
 * decorate them; only the fields consumed by the selected source are interpreted here.
 */
export function selectQuotePrice(quote: OptionQuote, source: PriceSource): number | undefined {
  requireArgumentObject('selectQuotePrice', 'quote', quote);
  ensureEnum(source, PRICE_SOURCES, 'source', 'selectQuotePrice');
  const value = selectQuotePriceKernel(quote, source);
  if (value !== undefined) ensureNonNegative(value, 'resolvedPrice', 'selectQuotePrice');
  return value;
}
