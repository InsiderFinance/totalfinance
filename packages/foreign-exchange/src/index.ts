/**
 * `@totalfinance/foreign-exchange` — foreign-exchange foundations (FC5): the currency-pair quote
 * contract, conversion and cross rates, covered-interest-parity forwards and their valuation, and
 * currency exposure/hedging. A pair always identifies base and quote currency (`quotePerBase` =
 * quote units per ONE base unit); inversion is explicit; pip/point sizes are supplied, never
 * guessed; valuation takes explicit discount factors so conventions cannot mismatch silently.
 */

export * from './spot.js';
export * from './forwards.js';
export * from './exposure.js';
