/** Strategy types (spec §12). */

import type { Computed, EpochMs } from '@totalfinance/core';
import type { ExtendedGreeks } from '@totalfinance/options';

export type LegKind = 'call' | 'put' | 'stock';

/**
 * A share position inside a strategy (B4: a stock leg is a stock). `quantity` is signed shares —
 * positive = long, negative = short — never scaled by the option multiplier; `price` is the entry
 * price per share. A stock row carries no strike, no premium and no expiry.
 */
export interface StockLeg {
  kind: 'stock';
  /** Entry price per share. */
  price: number;
  /** Signed shares: positive = long, negative = short. */
  quantity: number;
  /** Never on a stock row (typed so a union read narrows to `undefined`, not to a fake 0). */
  strike?: undefined;
  premium?: undefined;
  expiry?: undefined;
  impliedVolatility?: undefined;
}

/**
 * An option leg. `quantity` is signed contracts — positive = long, negative = short — scaled by the
 * position multiplier; `premium` is the entry premium per share.
 */
export interface OptionLeg {
  kind: 'call' | 'put';
  /** Never on an option row (a stock row's entry price). */
  price?: undefined;
  strike: number;
  /** Entry premium per share. */
  premium: number;
  /** Signed contracts: positive = long, negative = short. */
  quantity: number;
  /**
   * Optional per-leg expiry (`YYYY-MM-DD` → 16:00 ET, or a full datetime). When omitted the leg uses
   * the position-level expiry supplied to `value()`. Set it for multi-expiry structures (calendars,
   * diagonals, double diagonals) so each leg is priced at its own time-to-expiry.
   */
  expiry?: string;
  /**
   * Optional per-leg implied volatility (decimal, e.g. `0.28`). When set, `value()`/`chartData()`/
   * `scenarioTable()` price this leg at its own IV instead of the position-level `vol` — so a real
   * chain (four distinct IVs on an iron condor) marks correctly. When omitted, the leg falls back to
   * the position-level `vol`. The result's `assumptions.volatilitySource` reports which was used.
   */
  impliedVolatility?: number;
}

/** A single position leg: a stock row or an option row, discriminated by `kind`. */
export type Leg = StockLeg | OptionLeg;

/** Where a mark-to-market's volatility came from: all position-level, all per-leg, or a mix. */
export type VolatilitySource = 'position' | 'perLeg' | 'mixed' | 'perCall';

/** How a position's entry premiums were obtained. */
export type PremiumSource = 'user' | 'model';
/** Which volatility priced a modeled entry premium (see `PositionAssumptions`). */
export type PremiumVolatilitySource = 'leg' | 'position' | 'mixed';

/**
 * Market snapshot for MODEL-priced entry premiums (§3.4). Supplied via `PositionConfig.market` with
 * `premiums: 'model'` so a builder given strikes but no fills (the profit-calculator user) still gets
 * breakevens / max P&L / PoP — every unpriced leg is priced from this market by the BSM engine.
 */
export interface PremiumMarket {
  spot: number;
  /**
   * Entry implied volatility (annualized decimal) for unpriced legs that carry no `impliedVolatility`
   * of their own — a leg's own volatility always wins, exactly as it does when `value()` marks it.
   */
  volatility: number;
  riskFreeRate: number;
  /** Entry time (epoch ms or ISO). Each leg's entry `t = yearFraction(asOf, leg.expiry ?? market.expiry)`. */
  asOf: EpochMs | string;
  dividendYield?: number;
  /** Default expiry for legs without their own `expiry` (single-expiry structures). */
  expiry?: string;
}

export interface PositionConfig {
  /** Contract multiplier for option legs (default 100). */
  multiplier?: number;
  /** Entry-premium source: `'user'` (from the leg inputs, default) or `'model'` (priced from `market`). */
  premiums?: PremiumSource;
  /**
   * Market for model-priced entry premiums (required when `premiums: 'model'` and any leg omits its
   * premium) — AND the position's remembered market (R5): `probability()`, `monteCarloProbability()`,
   * `value()`, `scenarioTable()`, and `chartData()` use it as their default market, with per-call
   * fields merged over it. Results echo `marketSource: 'construction' | 'call' | 'merged'`.
   */
  market?: PremiumMarket;
  /**
   * Position-level default expiry (`YYYY-MM-DD` → 16:00 ET, or a datetime) applied to every leg
   * that has no `expiry` of its own. Named builders route their input's `expiry` here. Precedence
   * per leg: `leg.expiry` > `expiry` > `market.expiry` (R4).
   */
  expiry?: string;
}

/**
 * EXACT {@link PositionConfig} fields (Law 12) — shared by the named builders (`manifest.ts`) and
 * the generic constructors (`Position`), so `{ premums: 'model' }` teaches with a did-you-mean
 * everywhere instead of silently pricing with user premiums.
 */
export const POSITION_CONFIG_KEYS = ['multiplier', 'premiums', 'market', 'expiry'] as const;

/**
 * Where the market fields a computation ran with came from (R5): entirely from the construction
 * market (`'construction'`), entirely from the call site (`'call'`), or a merge of both
 * (`'merged'`). Echoed on every market-consuming result so it can answer "what did you assume?".
 */
export type MarketSource = 'construction' | 'call' | 'merged';

/**
 * A leg before entry-price resolution: an option's `premium` (or a stock's `price`) is optional
 * and filled by the model — the Black–Scholes–Merton premium, the market spot — when omitted
 * under `{ premiums: 'model', market }`.
 */
export type LegInput =
  | (Omit<StockLeg, 'price'> & { price?: number })
  | (Omit<OptionLeg, 'premium'> & { premium?: number });

/** Position-construction assumptions (design law #3): how entry premiums were sourced. */
export interface PositionAssumptions {
  /** `'user'` when every entry premium was supplied; `'model'` when any was priced from `market`. */
  premiumSource: PremiumSource;
  /**
   * When premiums were modeled, which volatility priced them: each leg's own `impliedVolatility`
   * (`'leg'`), the position-level `market.volatility` (`'position'`), or both across legs
   * (`'mixed'`) — the same source `value()` marks with, so a chain-fed position opens flat.
   */
  premiumVolatilitySource?: PremiumVolatilitySource;
  /** Contract multiplier applied to option legs. */
  multiplier: number;
  /** The named builder that constructed this position (provenance — see `classifyStrategy`). */
  constructedAs?: string;
}

export interface PriceRange {
  from: number;
  to: number;
  steps: number;
}

export interface PayoffMetrics {
  /** Net cash to enter: positive = debit paid, negative = credit received. */
  netDebit: number;
  /** Net credit received (the negation of `netDebit`). */
  netCredit: number;
  /** Maximum profit at expiration, or `null` when the profit is unbounded (`bounded.profit`). */
  maxProfit: number | null;
  /** Maximum loss at expiration as a negative number, or `null` when unbounded (`bounded.loss`). */
  maxLoss: number | null;
  /**
   * Whether each tail is bounded. An unbounded side is `null` above, never `Infinity` (B3): a
   * naked short call has `bounded.loss === false`, a long call `bounded.profit === false`.
   */
  bounded: { profit: boolean; loss: boolean };
  /** Underlying prices at which expiration P&L is zero. */
  breakevens: number[];
}

export interface PayoffResult extends PayoffMetrics {
  /** Chart-ready points of expiration P&L vs. underlying price. */
  points: Array<{ underlyingPrice: number; pnl: number }>;
}

export interface MarkToMarketInput {
  /** Underlying spot price (WS3.2: renamed from `underlyingPrice` for workspace consistency). */
  spot: number;
  /** Snapshot time. Epoch ms, or an ISO date/datetime string parsed at the boundary. */
  asOf: EpochMs | string;
  expiry: string;
  /**
   * Position-level implied volatility. OPTIONAL: a position whose every option leg carries its own
   * `iv` prices entirely per-leg and needs no position vol. It is required (and validated positive)
   * only when at least one un-expired option leg has no per-leg `iv`; omitting it then throws.
   */
  volatility?: number;
  riskFreeRate: number;
  dividendYield?: number;
  /**
   * Additive volatility shock (decimal) applied to EVERY effective leg volatility — the per-leg
   * `impliedVolatility` when a leg carries one, and the position-level `volatility` otherwise. This
   * is what makes a volatility scenario reach per-leg-IV legs; without it, shocking only
   * `volatility` is a silent no-op for legs that fix their own implied volatility.
   */
  volatilityShock?: number;
  /**
   * Per-leg volatility OVERRIDES for this call (Preview P1), aligned to `position.legs`: leg `i`
   * prices at `legVolatilities[i]` when it is a number, else at its own `impliedVolatility`, else at
   * the position-level `volatility` (`volatilityShock` still adds on top). This is how a mark from
   * CURRENT contract quotes reaches a position whose legs were built with entry volatilities — the
   * position stays immutable, the call states the market. `assumptions.volatilitySource` reports
   * `'perCall'` when any override applied.
   */
  legVolatilities?: readonly (number | undefined)[];
}

export interface LegValuation {
  leg: Leg;
  value: number;
  pnl: number;
  /** Full extended greeks (first + second-order) — the second-order fields power higher-order P&L
   *  attribution (`explainPositionPnl`) automatically. A stock leg is pure delta; an expired leg zeroed. */
  greeks: ExtendedGreeks;
}

export interface MarkToMarketResult extends Computed<
  number,
  { volatilitySource: VolatilitySource; marketSource: MarketSource }
> {
  /** Current mark-to-market P&L (also `value`). */
  pnl: number;
  perLeg: LegValuation[];
  /** Book-aggregate extended greeks: additive fields summed over legs; `lambda` (Δ·S/V) recomputed at
   *  the book level (null when the book value underflows to 0). */
  greeks: ExtendedGreeks;
}

export interface ChartInclude {
  expirationPnl?: boolean;
  currentPnl?: boolean;
  delta?: boolean;
  theta?: boolean;
}

// ─────────────────────────── What-if cube (spec: docs/specs/what-if-cube.md) ───────────────────────────

/** One cell of a {@link WhatIfCubeValue}: a mark-to-market at a (spot, vol shock, days-forward) point. */
export interface WhatIfCell {
  underlyingPrice: number;
  /** Additive vol shock applied (decimal). */
  volatilityShock: number;
  /** Calendar days advanced from `asOf`. */
  daysForward: number;
  /** Mark-to-market P&L in this scenario. */
  pnl: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** A point of the optimal-exit surface: per (spot, vol shock), the day that optimizes P&L. */
export interface OptimalExitPoint {
  underlyingPrice: number;
  volatilityShock: number;
  /** The `daysForward` (from the time axis) that optimizes P&L at this (spot, vol). */
  daysForward: number;
  /** The optimized P&L there. */
  pnl: number;
}

/**
 * The GBM terminal-price law for the what-if cube's spot distribution (Wave 6 §3). Drift follows the
 * same measure grammar as {@link Position.probability} — there is no silent zero-drift default.
 */
export type WhatIfGbmProbabilityModel =
  | { kind: 'gbm'; annualizedVolatility: number; measure?: 'riskNeutral' }
  | {
      kind: 'gbm';
      annualizedVolatility: number;
      measure: 'realWorld';
      /** Annualized total expected return before dividend yield. */
      expectedReturn: number;
    }
  | {
      kind: 'gbm';
      annualizedVolatility: number;
      measure: 'explicit';
      /** Annualized arithmetic GBM drift used directly for the underlying process. */
      drift: number;
    };

/** The what-if cube's spot process: a GBM (by measure) or an explicit terminal density over a support. */
export type WhatIfProbabilityModel =
  | WhatIfGbmProbabilityModel
  | {
      kind: 'custom';
      density: (price: number, yearsForward: number) => number;
      support: { from: number; to: number };
    };

/** Probability-mode options for {@link Position.whatIfCube}. */
export interface WhatIfProbabilityOptions {
  model: WhatIfProbabilityModel;
  /** How finite price-grid tails are handled; default `'report-and-renormalize'`. */
  gridPolicy?: 'report-and-renormalize' | 'include-in-edge-bins';
}

/** Options for {@link Position.whatIfCube}. */
export interface WhatIfCubeOptions {
  /** Market overrides; defaults from the construction market (R5). */
  market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
  /** Spot axis: an explicit grid array or a `{ from, to, steps }` range. Omit for the default window. */
  prices?: number[] | PriceRange;
  /** Additive vol shocks (decimal), e.g. `[-0.05, 0, 0.05]`. Default `[0]`. */
  volatilityShocks?: number[];
  /** Calendar days to advance `asOf`, e.g. `[0, 7, 30]`. Default `[0]`. */
  daysForward?: number[];
  /** Which extremum the optimal-exit surface picks per (spot, vol); default `'max-pnl'`. */
  objective?: 'max-pnl' | 'min-pnl';
  /**
   * Opt-in probability weighting (Wave 6 §3). When set, the result gains a `probability` block with the
   * per-day spot mass, disclosed tails, and per-(vol, day) expected P&L. Requires strictly increasing
   * unique prices and non-negative days.
   */
  probability?: WhatIfProbabilityOptions;
}

/** The what-if cube's probability block — resolved spot mass per day, tails, and expected P&L. */
export interface WhatIfCubeProbability {
  /** Day outer, price inner. Volatility-independent spot mass (renormalized in-grid per `gridPolicy`). */
  spotMassByDay: number[][];
  /** Per day, the raw mass below the grid's lower edge and above its upper edge (before renormalization). */
  tailMassByDay: Array<{ below: number; above: number }>;
  gridPolicy: 'report-and-renormalize' | 'include-in-edge-bins';
  /** `conditional-on-grid` (tails renormalized out) or `edge-censored` (tails folded into edge bins). */
  expectationMeaning: 'conditional-on-grid' | 'edge-censored';
  /** The resolved model, echoed — including the resolved drift, so the assumption is inspectable. */
  modelAssumptions:
    | {
        kind: 'gbm';
        measure: 'riskNeutral';
        annualizedVolatility: number;
        riskFreeRate: number;
        dividendYield: number;
        resolvedDrift: number;
      }
    | {
        kind: 'gbm';
        measure: 'realWorld';
        annualizedVolatility: number;
        expectedReturn: number;
        dividendYield: number;
        resolvedDrift: number;
      }
    | {
        kind: 'gbm';
        measure: 'explicit';
        annualizedVolatility: number;
        drift: number;
        resolvedDrift: number;
      }
    | { kind: 'custom'; support: { from: number; to: number } };
  /** Volatility-shock outer, day inner. Probability-weighted expected P&L, interpreted by `expectationMeaning`. */
  expectedPnlByVolatilityAndDay: number[][];
}

/** The what-if cube's break-even-time surface: the first non-negative-P&L day per (price, vol). */
export interface WhatIfCubeBreakEven {
  /** Price outer, vol-shock inner. The `daysForward` value of the first non-negative-P&L day, or `null`. */
  firstNonNegativeDayByPriceAndVolatility: Array<Array<number | null>>;
}

/** The cube value: the axes, the flat (row-major) cells, the optimal-exit surface, and the extremes. */
export interface WhatIfCubeValue {
  axes: { prices: number[]; volatilityShocks: number[]; daysForward: number[] };
  /** Flat cells, row-major: price outer, vol middle, day inner. */
  cells: WhatIfCell[];
  /** One entry per (price, volatilityShock) — the optimal-exit surface over the (spot, vol) plane. */
  optimalExit: OptimalExitPoint[];
  /** The global maximum-P&L cell across the whole cube. */
  best: WhatIfCell;
  /** The global minimum-P&L cell across the whole cube. */
  worst: WhatIfCell;
  /** Time-to-break-even surface — the first non-negative-P&L day per (price, vol). Always present. */
  breakEven: WhatIfCubeBreakEven;
  /** Probability weighting — present only when `probability` was requested. */
  probability?: WhatIfCubeProbability;
}

/** Result of {@link Position.whatIfCube} — the R2 one-envelope form. */
export type WhatIfCubeResult = Computed<WhatIfCubeValue, { marketSource: MarketSource }>;
