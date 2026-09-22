/**
 * Risk-owned STRUCTURAL mirrors of the `@insiderfinance/totalfinance/strategy` shapes that the book / VaR / P&L-explain
 * analytics consume.
 *
 * The platform layering points **strategy → risk** (the strategy optimizer composes risk's sizing), so
 * `@insiderfinance/totalfinance/risk` must never import from `@insiderfinance/totalfinance/strategy` — a type-only import is still a build
 * edge and would make the two packages mutually dependent. These interfaces capture *exactly* the
 * members risk reads from a strategy `Position` and the results of its `value()` / `metrics()`; a real
 * `Position` (a structural superset) stays assignable to `StrategyPosition` with no cast, so behavior
 * is unchanged. `scenario.ts` already follows this same pattern with its own structural `Position`.
 *
 * Keep in sync with `@insiderfinance/totalfinance/strategy`'s `Leg` / `LegValuation` / `MarkToMarketResult` / `MarkToMarketInput` /
 * `PayoffMetrics`. The cross-package structural assignability is asserted in
 * `test/strategy-shape.test.ts`, so a drift that breaks it fails CI.
 */

import type { EpochMs } from '@totalfinance/core';
import type { ExtendedGreeks } from '@totalfinance/options';

/** A leg's instrument kind (mirrors strategy's `LegKind`). */
export type StrategyLegKind = 'call' | 'put' | 'stock';

/** A stock row of a strategy position (mirrors strategy's `StockLeg`): signed shares at a price. */
export interface StrategyStockLeg {
  kind: 'stock';
  price: number;
  quantity: number;
  strike?: undefined;
  premium?: undefined;
  expiry?: undefined;
  impliedVolatility?: undefined;
}

/** An option row of a strategy position (mirrors strategy's `OptionLeg`). */
export interface StrategyOptionLeg {
  kind: 'call' | 'put';
  price?: undefined;
  strike: number;
  premium: number;
  quantity: number;
  expiry?: string;
  impliedVolatility?: number;
}

/** The subset of a strategy `Leg` that risk reads (mirrors `@insiderfinance/totalfinance/strategy`'s `Leg` union). */
export type StrategyLeg = StrategyStockLeg | StrategyOptionLeg;

/** The mark-to-market market a strategy `Position.value()` accepts (mirrors `MarkToMarketInput`). */
export interface StrategyMarkToMarketMarket {
  spot: number;
  asOf: EpochMs | string;
  expiry: string;
  volatility?: number;
  riskFreeRate: number;
  dividendYield?: number;
  volatilityShock?: number;
}

/** One leg's valuation from `Position.value()` (mirrors `LegValuation`). */
export interface StrategyLegValuation {
  leg: StrategyLeg;
  value: number;
  pnl: number;
  greeks: ExtendedGreeks;
}

/** The mark-to-market result risk reads from `Position.value()` (mirrors `MarkToMarketResult`). */
export interface StrategyMarkToMarketResult {
  value: number;
  pnl: number;
  perLeg: StrategyLegValuation[];
  greeks: ExtendedGreeks;
}

/** The subset of `PayoffMetrics` risk reads from `Position.metrics()` (`null` = unbounded loss). */
export interface StrategyPayoffMetrics {
  maxLoss: number | null;
  bounded: { profit: boolean; loss: boolean };
}

/**
 * The structural surface of a strategy `Position` that risk depends on: signed legs, a `value()`
 * mark-to-market that merges over the position's remembered market, and a single-expiry `metrics()`
 * payoff. A real `Position` (from `strategy(...)` or a named builder) satisfies this without a cast.
 */
export interface StrategyPosition {
  readonly legs: readonly StrategyLeg[];
  value(overrides?: Partial<StrategyMarkToMarketMarket>): StrategyMarkToMarketResult;
  metrics(): StrategyPayoffMetrics;
}
