/**
 * `@totalfinance/crypto` — crypto-native analytics. The first package in the Crypto tier.
 *
 * Perpetual-swap funding, dated-futures basis + the carry-curve term structure, cash-and-carry, the
 * perp-vs-future no-arbitrage carry spread, and the inverse (coin-margined) future & its coin-delta hedge —
 * the annualized, comparable, no-arb-grounded numbers every crypto trader watches. Deterministic (no
 * stochastic model), browser-safe, and depends only on `@totalfinance/core`.
 *
 * The inverse *option* (Deribit coin-settled) lives in `@totalfinance/options` (`inverseOption`); the 24/7
 * trading calendar lives in `@totalfinance/calendars` (`crypto24x7`).
 */

export {
  perpetualFunding,
  futuresBasis,
  predictedFunding,
  fundingBasisSpread,
  optionsBasisSpread,
} from './carry.js';
export type {
  PerpetualFundingInput,
  PerpetualFunding,
  FuturesBasisInput,
  FuturesBasis,
  BasisStructure,
  PredictedFundingInput,
  PredictedFunding,
  FundingBasisSpreadInput,
  FundingBasisSpread,
  CarrySignal,
  OptionsBasisSpreadInput,
  OptionsBasisSpread,
  OptionsCarrySignal,
} from './carry.js';

export { inverseFuture, inverseHedge } from './inverse.js';
export type {
  InverseSide,
  InverseFutureInput,
  InverseFuture,
  InverseHedgeInput,
  InverseHedge,
} from './inverse.js';

export { liquidationPrice } from './liquidation.js';
export type {
  MarginMode,
  LiquidationInput,
  Liquidation,
  LiquidationAssumptions,
} from './liquidation.js';

export { carryCurve } from './curve.js';
export type {
  CarryCurveFuture,
  CarryCurveInput,
  CarryCurvePoint,
  CarryForward,
  CarryInterp,
  CarryCurveShape,
  CarryCurve,
} from './curve.js';
