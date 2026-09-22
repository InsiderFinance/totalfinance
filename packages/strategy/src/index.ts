/**
 * `@insiderfinance/totalfinance/strategy` — the browser-first options profit calculator (spec §12).
 *
 * Build a position from legs, then compute expiration payoff, breakevens, max profit/loss,
 * mark-to-market P&L, and per-leg/aggregate Greeks. Does NOT depend on `@insiderfinance/totalfinance/volatility`.
 *
 *   const position = strategy([
 *     legs.call({ strike: 100, premium: 4.25, quantity: 1 }),
 *     legs.call({ strike: 110, premium: 1.4, quantity: -1 }),
 *   ]);
 *   position.payoff({ prices: { from: 70, to: 140, steps: 141 } });
 */

import { Position } from './position.js';
import type { LegInput, PositionConfig } from './types.js';
import * as manifest from './manifest.js';

export { Position, strategyOf } from './position.js';
export { legs } from './legs.js';
export type { OptionLegInput, StockLegInput } from './legs.js';
export type { VerticalInput, StraddleInput, StrangleInput, IronCondorInput } from './builders.js';
export type { Role } from './validate.js';
export { strategyFromChain } from './from-chain.js';
export type { FromChainType, FromChainOptions, ChainFill, FromChainResult } from './from-chain.js';
// Repairs B7 nameability: strategyFromChain takes core's OptionQuote rows — nameable from THIS package.
export type { OptionQuote } from '@totalfinance/core';
// The full named-strategy set (app OPC parity) is exported via the MANIFEST (dx §4.5): every
// builder is wrapped once there, so its positions carry `constructedAs` and every builder is
// registered for `listStrategies()` / `classifyStrategy()` — a builder that bypassed the manifest
// would fail the round-trip law in CI. The raw registry (`strategyRegistry`) stays internal:
// the public dynamic surface is `listStrategies()` + `buildStrategy(name, input)`.
export {
  longCall,
  shortCall,
  longPut,
  shortPut,
  cashSecuredPut,
  bullCallSpread,
  bearCallSpread,
  bullPutSpread,
  bearPutSpread,
  straddle,
  strangle,
  shortStraddle,
  shortStrangle,
  strip,
  strap,
  guts,
  shortGuts,
  longCombo,
  shortCombo,
  longSyntheticFuture,
  shortSyntheticFuture,
  syntheticPut,
  bullCallLadder,
  bearCallLadder,
  bullPutLadder,
  bearPutLadder,
  callBrokenWing,
  putBrokenWing,
  inverseCallBrokenWing,
  inversePutBrokenWing,
  jadeLizard,
  reverseJadeLizard,
  callRatioSpread,
  putRatioSpread,
  callRatioBackspread,
  putRatioBackspread,
  longCallButterfly,
  longPutButterfly,
  shortCallButterfly,
  shortPutButterfly,
  longCallCondor,
  longPutCondor,
  shortCallCondor,
  shortPutCondor,
  ironCondor,
  inverseIronCondor,
  ironButterfly,
  inverseIronButterfly,
  coveredCall,
  protectivePut,
  collar,
  coveredShortStraddle,
  coveredShortStrangle,
  calendarCallSpread,
  calendarPutSpread,
  diagonalCallSpread,
  diagonalPutSpread,
  doubleDiagonal,
  listStrategies,
  buildStrategy,
} from './manifest.js';
export type { StrategyDescriptor, BuildStrategyInput } from './manifest.js';
export { classifyStrategy, strategySignature } from './classify.js';
export type { ClassifiableLeg, StrategyMatch } from './classify.js';
// Input types for the named strategies (values come from the manifest above).
export type {
  StrikeLeg,
  UnitInput,
  SingleLegInput,
  LadderInput,
  JadeLizardInput,
  ReverseJadeLizardInput,
  TwoStrikeInput,
  SyntheticInput,
  SyntheticPutInput,
  RatioInput,
  CondorInput,
  IronButterflyInput,
  ShortStraddleInput,
  ShortStrangleInput,
  StockOptionInput,
  CollarInput,
} from './strategies.js';
export type {
  CalendarInput,
  DiagonalInput,
  DoubleDiagonalSide,
  DoubleDiagonalInput,
} from './calendars.js';
export type {
  Leg,
  LegInput,
  LegKind,
  OptionLeg,
  StockLeg,
  MarketSource,
  VolatilitySource,
  PremiumSource,
  PremiumVolatilitySource,
  PremiumMarket,
  PositionConfig,
  PositionAssumptions,
  PriceRange,
  PayoffMetrics,
  PayoffResult,
  MarkToMarketInput,
  MarkToMarketResult,
  LegValuation,
  ChartInclude,
  WhatIfCell,
  OptimalExitPoint,
  WhatIfCubeOptions,
  WhatIfCubeValue,
  WhatIfCubeResult,
  WhatIfGbmProbabilityModel,
  WhatIfProbabilityModel,
  WhatIfProbabilityOptions,
  WhatIfCubeProbability,
  WhatIfCubeBreakEven,
} from './types.js';
export type {
  ProbabilityInput,
  ProbabilityMeasure,
  ProbabilityMetrics,
  ProbabilityMonteCarloInput,
  ProbabilityMonteCarloMetrics,
  ProbabilityModel,
  TouchProbability,
  ScenarioRow,
  ScenarioTableResult,
} from './probability.js';
export { SCAN_OBJECTIVES, scanStrategies } from './scanner.js';
export type {
  ScanStructure,
  ScanQuoteRow,
  ScanObjective,
  ScanOptions,
  ScanCandidate,
} from './scanner.js';
// Strategy optimizer (Tier 3): invert the calculator — rank structures × strikes × expiries by
// expected P&L under the trader's thesis, not the market's risk-neutral distribution.
export { optimizeStrategy } from './optimizer.js';
export type {
  OptimizerThesis,
  OptimizerExpiry,
  OptimizerObjective,
  OptimizerSizingOptions,
  OptimizeStrategyOptions,
  OptimizedStrategy,
  OptimizedStrategyCapital,
  OptimizedStrategyKelly,
  OptimizeStrategyResult,
} from './optimizer.js';
// Zero-dependency payoff SVG rendering: turn any Position into a self-contained <svg> diagram.
export { payoffSvg } from './svg.js';
export type { PayoffSvgOptions } from './svg.js';
// Agent-native "explain this position" — classify + metrics + probability + greeks → prose.
export { explainPosition } from './explain.js';
export type {
  ExplainPositionOptions,
  PositionExplanation,
  DirectionalBias,
  MoveBias,
  VolatilityBias,
  TimeBias,
} from './explain.js';

/**
 * Build a position from legs, with the full named-strategy set attached (app OPC parity): verticals,
 * ladders, ratio spreads/backspreads, broken wings, jade lizards, guts, strips/straps, condors,
 * butterflies, iron variants, straddles/strangles, synthetics/combos, covered/collar/protective
 * stock combos, and the multi-expiry calendars/diagonals/double-diagonal.
 */
const { strategyRegistry: _internalRegistry, ...publicManifest } = manifest;

export const strategy = Object.assign(
  (positionLegs: readonly LegInput[], config?: PositionConfig): Position =>
    new Position(positionLegs, config),
  publicManifest,
);
