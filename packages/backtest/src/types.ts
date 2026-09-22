/**
 * Shared backtest types (spec §16). Both engines — the vectorized research loop and the event-driven
 * execution simulator — return the same `BacktestResult` shape so results are comparable, and every
 * run echoes the modelling assumptions a backtest usually hides on `assumptions` (dx §2.5) alongside
 * its **implementation-risk diagnostics** (§16.3).
 */

import { requireArgumentArray } from '@totalfinance/core';
import type { Bar, Diagnostics, EpochMs, OrderSide, SymbolId } from '@totalfinance/core';
import type { PerformanceSummary } from '@totalfinance/performance';

export type { Bar };

export type OptionSettlementStyle = 'physical' | 'cash';

/** Registration of an option symbol so the broker can mark and settle it (spec §16.2). */
export interface OptionContractSpecification {
  /** The underlying symbol the option exercises into. */
  underlying: SymbolId;
  type: 'call' | 'put';
  strike: number;
  /** Expiry instant, epoch ms (B6: the same name every resolved contract carries). */
  expiresAt: EpochMs;
  /** Contract multiplier (underlier shares per contract). Default 100. */
  multiplier?: number;
  /** `physical` (deliver/receive the underlier at strike, default) or `cash` (pay/receive intrinsic). */
  settlement?: OptionSettlementStyle;
  /**
   * Exercise style (default `american`). Only `american` options are eligible for the EARLY
   * exercise/assignment model (WS7.4); `european` options settle only at expiry. The early model is
   * itself opt-in via the broker's `assignment: 'model'` policy, so this field is inert by default.
   */
  style?: 'american' | 'european';
}

/** The record of an option position settled at expiry. */
export interface OptionSettlement {
  symbol: SymbolId;
  underlying: SymbolId;
  timestampMs: EpochMs;
  type: 'call' | 'put';
  strike: number;
  multiplier: number;
  /** Signed contracts settled (negative = short). */
  contracts: number;
  /** Underlier settlement price. */
  underlierPrice: number;
  /** Intrinsic value per underlier share at settlement. */
  intrinsic: number;
  /** `exercised` (long, ITM), `assigned` (short, ITM), or `expired` (out-of-the-money). */
  action: 'exercised' | 'assigned' | 'expired';
  settlement: OptionSettlementStyle;
  /** Net cash effect of the settlement. */
  cashFlow: number;
  /** Signed underlier shares delivered/received on physical exercise/assignment (0 otherwise). */
  shares: number;
  /** `true` when this was an EARLY (pre-expiry) American exercise/assignment (WS7.4). */
  early?: boolean;
  /** Why an early event fired: `'dividend'`, `'deep-itm'`, or `'manual'` (absent for expiry). */
  reason?: 'dividend' | 'deep-itm' | 'manual';
}

/** Version tag of the golden benchmark fixtures the engines are validated against (spec §16.3). */
export const BENCHMARK_FIXTURE_VERSION = '0.0.1';

/**
 * The modelling assumptions a backtest makes, echoed on every result's `assumptions` slot so they are
 * never hidden (spec §16.3 / dx §2.5). Each policy is a short, stable, machine-readable label.
 */
export interface BacktestAssumptions {
  /** Version of the library's default conventions (core `CONVENTIONS_VERSION`). */
  conventionsVersion: string;
  /** Opening capital the run started from. */
  initialCapital: number;
  /** When/at what price orders fill, e.g. `next-open`, `close`, `trigger-price`. */
  fill: string;
  /** Commission model applied, e.g. `bps(1)`, `per-share(0.005)`, `none`. */
  cost: string;
  /** Slippage model applied, e.g. `bps(2)`, `spread`, `none`. */
  slippage: string;
  /** Cash settlement assumption, e.g. `immediate` (T+0). */
  cashSettlement: string;
  /** Corporate-action handling, e.g. `dividends-as-cash`, `splits-adjusted`, `none`. */
  corporateAction: string;
  /** Rebalancing/trading calendar, e.g. `every-bar`, `monthly`, `signal-driven`. */
  calendar: string;
  /** Leverage/margin regime: `unconstrained` (no cap; unfunded fills allowed) or `maxLeverage`. */
  margin: string;
  /** American early exercise/assignment policy: `model` or `none` (WS7.4). Absent where inapplicable. */
  assignment?: string;
  /**
   * How an OCO group resolves a bar that touches BOTH legs. One bar cannot say which trigger came
   * first, and the engine's answer — the take-profit, because a bracket submits it before the
   * stop-loss and orders fill in submission order — is optimistic. It is disclosed here rather than
   * left as an undocumented mechanic (`take-profit-first-on-ambiguous-bar`). Absent for engines with
   * no order book (the vectorized loop).
   */
  oco?: string;
}

/**
 * The implementation-risk diagnostics attached to every {@link BacktestResult} (spec §16.3): core
 * {@link Diagnostics} (look-ahead / leakage checks and data-alignment warnings — empty when clean)
 * plus the benchmark fixture version the engine was validated against. The echoed run policies live
 * on the result's `assumptions` slot (dx §2.5) — diagnostics say how trustworthy the run is,
 * assumptions say what was assumed.
 */
export interface ImplementationRisk extends Diagnostics {
  /** The benchmark fixture version this engine was validated against. */
  benchmarkFixtureVersion: string;
}

/** A filled trade. `quantity` is always positive; `side` carries the direction (core `OrderSide`, B6). */
export interface Trade {
  symbol: SymbolId;
  timestampMs: EpochMs;
  side: OrderSide;
  /** Filled quantity (> 0). */
  quantity: number;
  /** Fill price *after* slippage. */
  price: number;
  /** Commission charged on this fill. */
  commission: number;
  /** Slippage cost (signed against the trader) embedded in `price` vs the reference. */
  slippage: number;
  /**
   * Contract multiplier of the instrument traded — `1` for a share, the registered option's
   * multiplier (default 100) for an option symbol. Cash value of the fill is
   * `quantity · price · multiplier`; turnover and realized-P&L attribution apply it or a
   * 100×-multiplier option trade is reported at 1% of its true size. Every engine stamps it —
   * the share-only loops (vectorized, cross-sectional) stamp `1` by construction — so no reader
   * has to guess what an absent field meant.
   */
  multiplier: number;
}

/** The cash value of a fill: `quantity · price · multiplier`. */
export function tradeNotional(trade: Trade): number {
  return trade.quantity * trade.price * trade.multiplier;
}

/** An open position snapshot. */
export interface Position {
  symbol: SymbolId;
  /** Signed quantity (negative = short). */
  quantity: number;
  /** Average entry price of the current position. */
  averagePrice: number;
}

/**
 * One point on the equity curve: a timestamp paired unambiguously with the portfolio value at that
 * instant (WS2.8). `points[0]` stamps the opening capital at the FIRST bar's timestamp; each later
 * point is the post-bar equity at that bar's timestamp — one series, no `equityCurve`/`timestamps`
 * off-by-one to reconcile.
 */
export interface EquityPoint {
  timestampMs: EpochMs;
  equity: number;
}

/**
 * Build the {@link EquityPoint} series from an engine's internal `equityCurve` (length n+1, index 0 =
 * opening capital) and `timestamps` (length n, one per bar).
 */
export function toEquityPoints(equityCurve: number[], timestamps: EpochMs[]): EquityPoint[] {
  requireArgumentArray('toEquityPoints', 'equityCurve', equityCurve);
  requireArgumentArray('toEquityPoints', 'timestamps', timestamps);
  if (timestamps.length === 0) return [];
  const points: EquityPoint[] = [{ timestampMs: timestamps[0]!, equity: equityCurve[0]! }];
  for (let i = 0; i < timestamps.length; i++) {
    points.push({ timestampMs: timestamps[i]!, equity: equityCurve[i + 1]! });
  }
  return points;
}

/** The common result shape returned by both engines. */
export interface BacktestResult {
  /**
   * The equity curve as an explicit `(ts, equity)` series (length = number of bars + 1). `points[0]`
   * is the opening capital stamped at the first bar's timestamp; see {@link EquityPoint}.
   */
  points: EquityPoint[];
  /** Per-bar simple returns of the equity curve. */
  returns: number[];
  /** Every filled trade, in order. */
  trades: Trade[];
  /** Final portfolio value. */
  finalValue: number;
  /** Sum of |traded notional| ÷ average equity — a turnover proxy. */
  turnover: number;
  /** Performance metrics of the equity curve (`@insiderfinance/totalfinance/performance`). */
  performance: PerformanceSummary;
  /** The modelling assumptions this run made — capital, fills, costs, calendar, margin (dx §2.5). */
  assumptions: BacktestAssumptions;
  /** Implementation-risk diagnostics: warnings + benchmark fixture version (spec §16.3). */
  diagnostics: ImplementationRisk;
  /** Option positions settled at expiry (exercise / assignment / worthless), if any. */
  settlements?: OptionSettlement[];
}
