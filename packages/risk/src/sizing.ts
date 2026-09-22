/**
 * Focused position-sizing surface — `@insiderfinance/totalfinance/risk/sizing`.
 *
 * Re-exports the two sizing primitives a downstream composer (the strategy optimizer) needs —
 * `kellyBet` (edge → growth-optimal fraction) and `optionsMargin` (Reg-T buying-power reduction) —
 * plus their public types, so `@insiderfinance/totalfinance/strategy` can depend on this narrow entry point instead of
 * pulling the whole risk barrel. Both remain available from the package root unchanged; this subpath
 * is purely additive. See `docs/specs/wave6-quant-moats.md` §2A.
 */

export { kellyBet } from './kelly.js';
export type { KellyBetInput, KellySizing, BinaryEdge, EdgeOutcome } from './kelly.js';

export { optionsMargin } from './portfolio.js';
export type { OptionMarginLeg, OptionsMarginOptions, OptionsMarginResult } from './portfolio.js';
