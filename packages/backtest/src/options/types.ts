/**
 * `@totalfinance/backtest/options` — types for the chain-driven options-strategy backtester.
 *
 * The product surface is DECLARATIVE (matching `@totalfinance/strategy`'s builders and the library's
 * S1 input-object idiom): a strategy is `{ entry, exit, roll?, hedge? }` config, with callback
 * escape hatches (`entry.when` / `entry.build` / `exit.when` / `roll.when`) for the tail. The engine
 * composes proven primitives — `strategyFromChain` for entry, `Position.value()` for marking,
 * `optionsMargin` for sizing — so it is a thin, honest driver, never a re-implementation.
 *
 * Stage 4.6 (FC8 Decision 5): the single open slot is a position BOOK. `entry` may be one rule or
 * several (each with an `id`), `book` bounds how many trades may be open, `limits` are pre-trade
 * gates evaluated on the post-trade book through `@totalfinance/risk`, `fillPolicy` says whether a
 * structure fills as one combo or leg by leg, `quoteFreshness` refuses fills on stale quotes exactly
 * as marking refuses stale marks, `corporateActions` adjust open legs with lineage, `dividends` are
 * early-assignment evidence, and the run emits the portfolio ledger it reconciles to. Every
 * existing request runs unchanged: `book.maximumOpenPositions` defaults to 1.
 */

import type { NormalizedFill } from '@totalfinance/portfolio';
import type { CorporateAction, Diagnostics, EpochMs, PriceSource } from '@totalfinance/core';
import type { Greeks } from '@totalfinance/options';
import type { PortfolioLedgerSnapshot, PortfolioTimelineResult } from '@totalfinance/portfolio';
import type { PnlExplain } from '@totalfinance/risk';
import type { OptionQuote } from '@totalfinance/core';
import type { FromChainType, Leg, Position } from '@totalfinance/strategy';
import type { PerformanceSummary } from '@totalfinance/performance';
import type { CostModel, SlippageModel } from '../costs.js';
import type { EquityPoint, OptionSettlement } from '../types.js';

/** One dated option chain: every listed quote at a single point in time (the backtest's tick). */
export interface ChainSnapshot {
  /**
   * Snapshot instant — epoch ms or a zoned ISO datetime. A bare `'YYYY-MM-DD'` is refused: the
   * time of day prices the chain. An end-of-day chain is observed at the close —
   * `usEquitySessionInstant(date, 'close')` from `@totalfinance/core`.
   */
  asOf: EpochMs | string;
  /** Underlying spot at this snapshot (the mark for pricing and delta-hedging). */
  underlyingPrice: number;
  /**
   * Every listed contract's quote. Delta-based strike selection reads `greeks.delta` per quote (stamp
   * it with `@totalfinance/options` `chainGreeks` if your source lacks it); other selections do not need it.
   */
  quotes: OptionQuote[];
}

/** Which listed expiry to trade: the one whose days-to-expiry is nearest `target`, within `[min,max]`. */
export interface DaysToExpiryTarget {
  /** Preferred days to expiry. */
  target: number;
  /** Reject expiries with fewer DTE than this (default: no floor). */
  min?: number;
  /** Reject expiries with more DTE than this (default: no ceiling). */
  max?: number;
}

/** When to open a position: only when this rule is flat (default), whenever the book has room, or a caller predicate. */
export type EntryWhen = 'flat' | 'always' | ((context: EntryContext) => boolean);

/** Context passed to entry callbacks (`when` / `build`). */
export interface EntryContext {
  snapshot: ChainSnapshot;
  asOf: EpochMs;
  cash: number;
  equity: number;
  /** True when this rule has no open trade. */
  flat: boolean;
  /** Trades open in the book at the decision instant, every rule's (Stage 4.6). */
  openTrades: readonly OpenTradeView[];
}

/** What a callback may see of an open trade: identity, structure, and the current mark. */
export interface OpenTradeView {
  tradeId: number;
  ruleId: string;
  structure: string;
  underlying: string;
  entryAsOf: EpochMs;
  entryPremium: number;
  markToMarket: number;
  legs: readonly Leg[];
}

/** How to size a position: a fixed contract count, or margin-aware (largest count within a budget). */
export type Sizing = { quantity: number } | { maxMarginFraction: number };

interface EntryCommon {
  /** Names the rule in trades and rows (default `rule-<index>`); unique across the rules. */
  id?: string;
  /** Gate for opening (default `'flat'`). */
  when?: EntryWhen;
  /** Expiry selection by days-to-expiry. */
  daysToExpiry: DaysToExpiryTarget;
  /** Contract sizing (default `{ quantity: 1 }`). */
  sizing?: Sizing;
  /** Fill price source for entry (default `'mid'`). */
  price?: PriceSource;
}

/** Multi-expiry selection for calendars and diagonals: the near leg by delta, the far leg by days. */
export interface MultiExpirySelection {
  /** Target |delta| of the short near leg. */
  shortDelta: number;
  /** Days-to-expiry target of the near (short) expiry. */
  nearDaysToExpiry: DaysToExpiryTarget;
  /** Days-to-expiry target of the far (long) expiry; must resolve to a later expiry than the near one. */
  farDaysToExpiry: DaysToExpiryTarget;
  /** Strike distance of the far leg from the near leg (diagonals: required; calendars: not allowed). */
  width?: number;
}

/**
 * The entry rule — a discriminated union over `structure`, mirroring `strategyFromChain`'s option
 * grammar so the declarative form maps 1:1 onto the library. The `build` variant is the full escape
 * hatch: return a `Position` (or `null` to skip) built however you like from the snapshot.
 */
export type EntryRule =
  | (EntryCommon & { structure: 'ironCondor'; select: { shortDelta: number; wingWidth: number } })
  | (EntryCommon & {
      structure: 'bullCallSpread' | 'bearCallSpread' | 'bullPutSpread' | 'bearPutSpread';
      select: { shortDelta: number; width: number };
    })
  | (EntryCommon & { structure: 'strangle'; select: { shortDelta: number } })
  | (EntryCommon & { structure: 'straddle'; select?: { strike?: number } })
  | (EntryCommon & {
      structure: 'coveredCall';
      select: { shortDelta: number; stockPrice?: number };
    })
  | (EntryCommon & {
      structure: 'protectivePut';
      select: { shortDelta: number; stockPrice?: number };
    })
  | (EntryCommon & {
      structure: 'calendarCallSpread' | 'calendarPutSpread';
      select: MultiExpirySelection;
    })
  | (EntryCommon & {
      structure: 'diagonalCallSpread' | 'diagonalPutSpread' | 'doubleDiagonal';
      select: MultiExpirySelection;
    })
  | (EntryCommon & { build: (context: EntryContext) => Position | null });

/** The declarative single-expiry `structure` values (a subset of {@link FromChainType}). */
export type EntryStructure = Exclude<FromChainType, 'calendar'>;

/** The declarative multi-expiry structures (Stage 4.6), built through `@totalfinance/strategy`'s constructors. */
export type MultiExpiryStructure =
  | 'calendarCallSpread'
  | 'calendarPutSpread'
  | 'diagonalCallSpread'
  | 'diagonalPutSpread'
  | 'doubleDiagonal';

/** Context passed to exit / roll callbacks. */
export interface ExitContext {
  snapshot: ChainSnapshot;
  asOf: EpochMs;
  position: Position;
  /** Signed entry premium (positive = net debit paid, negative = net credit received). */
  entryPremium: number;
  /** Current mark-to-market P&L of the position, in account currency. */
  markToMarket: number;
  /** `mtm / |entryPremium|` — the fraction of the entry premium captured (+) or lost (−). */
  pnlFraction: number;
  /** Calendar days to expiry (nearest leg for a multi-expiry structure). */
  daysToExpiry: number;
  /** Aggregate share-equivalent delta of the position. */
  netDelta: number;
  greeks: Greeks;
}

/**
 * When to close a position. Declarative triggers OR-combine with the `when` callback; the first to
 * fire closes the trade (its name is recorded as the exit reason).
 */
export interface ExitRule {
  /** Close when captured P&L reaches this fraction of the entry premium (e.g. `0.5` = 50%). */
  profitTarget?: number;
  /** Close when the loss reaches this multiple of the entry premium (e.g. `2` = 200%). */
  stopLoss?: number;
  /** Close at or below this many days to expiry. */
  daysToExpiry?: number;
  /** Arbitrary exit predicate (OR-combined with the declarative triggers). */
  when?: (context: ExitContext) => boolean;
}

/** Roll instead of closing flat: when the rule fires, close and immediately re-enter via `entry`. */
export interface RollRule {
  /** When to roll (defaults to the same triggers as {@link ExitRule}). */
  when?: ExitRule;
}

/** Keep the portfolio delta-neutral by trading the underlying whenever |net delta| exceeds the band. */
export interface DeltaHedgeRule {
  /** Rehedge to flat delta when the absolute share-equivalent net delta exceeds this many shares. */
  deltaBand: number;
  /** Slippage on the underlying hedge trades (defaults to the backtest's option slippage). */
  slippage?: SlippageModel;
  /** Commission on the underlying hedge trades (defaults to the backtest's option commission). */
  commission?: CostModel;
}

/** Where one open option leg's volatility came from at one snapshot (Preview P1). */
export type MarkSource = 'current-quote' | 'implied-from-price' | 'entry-volatility' | 'carried';

/** Why a current contract quote could not mark a leg (Preview P1). */
export type MissingMarkCause = 'missing' | 'ambiguous' | 'stale' | 'unpriceable';

/**
 * How open option legs are marked at every snapshot (Preview P1 — `docs/specs/options-backtest.md`,
 * "Preview P1 amendment"). Every member is optional; the defaults are the truthful ones.
 */
export interface MarkingPolicy {
  /**
   * `'current-quote'` (DEFAULT) re-marks each open leg from the exact current-snapshot contract
   * quote — its stated implied volatility, or one implied from the quote's selected price. `'entry'`
   * holds each leg's entry volatility for the whole trade (the pre-P1 behaviour, now explicit).
   */
  volatility?: 'current-quote' | 'entry';
  /**
   * What happens when the current contract cannot mark a leg under `'current-quote'`: `'refuse'`
   * (DEFAULT) throws `backtest.mark_unavailable` naming the leg, the snapshot, and the cause;
   * `'entry-volatility'` marks THAT leg at its entry volatility for THAT snapshot;
   * `'carry-last-volatility'` holds the leg's last successfully marked volatility (the mark still
   * reprices for spot and time). Both fallbacks are counted per trade and warned once per cause.
   */
  missingMark?: 'refuse' | 'entry-volatility' | 'carry-last-volatility';
  /**
   * A current quote whose `timestampMs` is older than the snapshot's `asOf` by more than this is
   * STALE and cannot mark (it falls to `missingMark`). Omitted ⇒ every quote a snapshot carries is
   * current by definition of the snapshot.
   */
  maximumQuoteAgeMs?: number;
}

/** The applied marking policy, echoed in the assumptions. */
export interface AppliedMarkingPolicy {
  volatility: 'current-quote' | 'entry';
  missingMark: 'refuse' | 'entry-volatility' | 'carry-last-volatility';
  maximumQuoteAgeMs: number | null;
}

/** How many leg-snapshot marks of a trade came from each source (Preview P1 evidence). */
export interface TradeMarkCounts {
  /** Snapshots on which the trade was open and marked. */
  snapshots: number;
  currentQuote: number;
  impliedFromPrice: number;
  /** The `'entry'` policy AND the `'entry-volatility'` fallback. */
  entryVolatility: number;
  carried: number;
}

/** How many trades the book may hold (Stage 4.6). */
export interface BookPolicy {
  /** Open trades at once (default 1 — the shipped single-position behaviour; at most 10,000). */
  maximumOpenPositions?: number;
  /** Open trades per underlying (default: no bound). */
  maximumPerUnderlying?: number;
}

/** Pre-trade limits evaluated on the post-trade book; a breach rejects the entry with a row. */
export interface PortfolioLimits {
  /** `optionsMargin` of the whole book ≤ fraction × equity. */
  maximumMarginFraction?: number;
  /** |Σ share-equivalent delta| per underlying ≤ this many shares. */
  maximumNetDelta?: number;
  /** |Σ vega| per underlying (account currency per 1.00 volatility) ≤ this. */
  maximumNetVega?: number;
  /** Premium at risk (Σ |entry premium|) in one underlying ≤ fraction × equity. */
  maximumConcentration?: number;
  /** The book's worst Taylor P&L over the shock grid (`scenarioGrid`) may not exceed fraction × equity. */
  scenarioLoss?: {
    /** Spot shocks as fractions (e.g. −0.1 for −10%). */
    spotShocks: readonly number[];
    /** Absolute volatility shocks (e.g. 0.05 for +5 points). */
    volatilityShocks: readonly number[];
    maximumLossFraction: number;
  };
}

/** How a structure's legs fill at entry (Stage 4.6). */
export interface FillPolicy {
  /** `'combo'` (default) fills every leg at once or rejects the entry; `'legged'` fills legs in order. */
  mode?: 'combo' | 'legged';
  /** Under `'legged'`: reject a structure whose sequence stops early (default), or hold the filled legs. */
  partialFill?: 'reject' | 'allow';
  /** The per-leg fill side (default: the rule's `price`, else `'mid'`). */
  price?: PriceSource;
}

/** A quote older than this at the decision instant cannot fill (the fill-side twin of `marking.maximumQuoteAgeMs`). */
export interface QuoteFreshnessPolicy {
  maximumQuoteAgeMs: number;
}

/** A cash dividend on an underlying — early-assignment and dividend-risk evidence. */
export interface DividendRecord {
  underlying: string;
  /** Ex-dividend date, `YYYY-MM-DD`. */
  exDate: string;
  /** Per-share amount, > 0. */
  amount: number;
}

export interface OptionsBacktestConfig {
  /** Time-ordered (or unordered — the engine sorts) chain snapshots. */
  chains: Iterable<ChainSnapshot>;
  /** How open legs are marked at every snapshot (default: current quote; refuse a missing mark). */
  marking?: MarkingPolicy;
  /** Opening capital (default 100,000). */
  initialCapital?: number;
  /**
   * Continuously-compounded risk-free rate (decimal) for every mark-to-market price and the
   * assignment carry. REQUIRED: a backtest that silently priced at 4% was a financial assumption
   * nobody stated.
   */
  riskFreeRate: number;
  /** Continuous dividend yield for pricing (default 0). */
  dividendYield?: number;
  /** One rule (the shipped form); exactly one of `entry` and `rules` is given. */
  entry?: EntryRule;
  /** Several rules at once (Stage 4.6): each a member of the book, entered in order at every snapshot. */
  rules?: readonly EntryRule[];
  exit: ExitRule;
  /** Roll instead of closing flat when the rule fires. */
  roll?: RollRule;
  /** Optional delta-hedging with the underlying. */
  hedge?: DeltaHedgeRule;
  /** Commission model for option trades (default none). */
  commission?: CostModel;
  /** Slippage model for option trades (default none). */
  slippage?: SlippageModel;
  /** American early-assignment modeling (default `'none'`; `'model'` uses the deep-ITM/ex-div heuristic). */
  assignment?: 'model' | 'none';
  /** Annualization factor for the performance summary (default 252). */
  periodsPerYear?: number;
  /** The book's capacity (default: one open trade). */
  book?: BookPolicy;
  /** Pre-trade limits on the post-trade book. */
  limits?: PortfolioLimits;
  /** Combo or legged fills; partial-fill policy; the per-leg fill side. */
  fillPolicy?: FillPolicy;
  /** Refuse fills on stale quotes. */
  quoteFreshness?: QuoteFreshnessPolicy;
  /** Splits and symbol changes adjust open legs with lineage; mergers and spin-offs on an open leg refuse. */
  corporateActions?: readonly CorporateAction[];
  /** Cash dividends: dividend-risk evidence per short call, early assignment under `assignment: 'model'`. */
  dividends?: readonly DividendRecord[];
  /** The account currency of the ledger (default `'USD'`). */
  baseCurrency?: string;
}

/** Why a trade closed. */
export type ExitReason =
  | 'profit-target'
  | 'stop-loss'
  | 'daysToExpiry'
  | 'signal'
  | 'expiry'
  | 'assignment'
  | 'roll'
  | 'open-at-end';

/** Per-leg realized P&L attribution for a closed (or marked-at-end) options trade. */
export interface LegAttribution {
  leg: Leg;
  realizedPnl: number;
}

/**
 * A closed trade's **greek P&L explain** (entry → exit): the realized gross mark P&L decomposed into
 * greek contributions (the full 2nd-order Taylor + dividend carry) plus an honest `unexplained`
 * residual, via `@totalfinance/risk`'s `explainPositionPnl`. These are the **bare terms** —
 * the backtest result carries the report envelope (`assumptions`/`diagnostics`) at the top level, so a
 * per-trade row stays a plain record (matching `perLeg`). The terms sum exactly to `total`, which is
 * anchored to the trade's gross (pre-cost) P&L: `total === realizedPnl + costs`. (The day-0 entry edge —
 * fill vs. model mark — is a model/data effect, so it lives in `unexplained`, not a greek term.)
 *
 * Under the default `'current-quote'` marking (Preview P1) each leg is re-marked from its current
 * contract quote, so `vega` (with `vanna`/`vomma`/`veta`) is a live term attributed per leg from the
 * entry volatility to the exit volatility; under `marking.volatility: 'entry'` the leg volatility is
 * held for the trade and those terms stay ~0. The rate is held fixed across the trade. See
 * `explainPositionPnl` for the per-leg vol-attribution contract.
 */
export type TradePnlExplain = Omit<PnlExplain, 'assumptions' | 'diagnostics'>;

/** A corporate action applied to an open trade's legs, with what changed. */
export interface TradeLineage {
  lineageId: string;
  action: CorporateAction['type'];
  effectiveDate: string;
  asOf: EpochMs;
  previous: { underlying: string; strikes: number[]; multiplier: number };
  adjusted: { underlying: string; strikes: number[]; multiplier: number };
}

/** A leg a legged fill could not fill, with why. */
export interface UnfilledLeg {
  leg: Leg;
  cause: 'missing' | 'ambiguous' | 'stale' | 'unpriceable';
}

/** One round-trip options trade in the backtest. */
export interface OptionsTrade {
  /** The structure as classified/constructed (e.g. `'bullPutSpread'`). */
  structure: string;
  entryAsOf: EpochMs;
  /** Exit time, or `null` if still open at the end of the run. */
  exitAsOf: EpochMs | null;
  expiry: string;
  contracts: number;
  /** Signed entry premium (positive = debit paid, negative = credit received), in account currency. */
  entryPremium: number;
  /** Realized P&L over the trade, net of costs, in account currency. */
  realizedPnl: number;
  /** Total commission + slippage paid on entry and exit. */
  costs: number;
  exitReason: ExitReason;
  perLeg: LegAttribution[];
  legs: readonly Leg[];
  /**
   * Greek P&L attribution of the trade's gross mark P&L (entry → exit), via `explainPositionPnl`. The
   * terms sum to `total` (≈ `realizedPnl + costs`); the `unexplained` residual is 3rd-order-and-higher.
   * See {@link TradePnlExplain}.
   */
  pnlExplain: TradePnlExplain;
  /** Where the trade's marks came from, counted over every open snapshot (Preview P1). */
  marks: TradeMarkCounts;
  /**
   * The volatility each leg was LAST marked at, aligned to `legs` — `null` for a stock leg or a leg
   * priced at intrinsic (expired/settled). Under `'current-quote'` this is the exit contract's
   * volatility; under `'entry'` it is the entry volatility.
   */
  exitVolatilities: (number | null)[];
  /** The book identity (Stage 4.6). */
  tradeId: number;
  ruleId: string;
  underlying: string;
  /** Ledger instrument ids aligned to `legs` (OCC symbols for options, the underlying for stock). */
  legInstrumentIds: string[];
  /** Corporate actions applied while the trade was open, oldest first. */
  lineage: TradeLineage[];
  /** True when a legged fill held fewer legs than the structure names. */
  partial: boolean;
  unfilledLegs: UnfilledLeg[];
  /** Legs settled before the trade closed (a calendar's near leg, an early assignment), aligned to `legs` by `legIndex`. */
  legSettlements: Array<{ legIndex: number; settlement: OptionSettlement }>;
}

/** An entry a limit rejected (Stage 4.6): the limit, the value the book would have had, the bound. */
export interface LimitRejection {
  asOf: EpochMs;
  ruleId: string;
  structure: string;
  limit: keyof PortfolioLimits;
  value: number;
  bound: number;
  /** `backtest.limit_rejected` */
  code: string;
}

/** An entry the fill policy rejected (Stage 4.6): the legs that could not fill and why. */
export interface FillRejection {
  asOf: EpochMs;
  ruleId: string;
  structure: string;
  mode: 'combo' | 'legged';
  unfilledLegs: UnfilledLeg[];
  /** `backtest.combo_leg_unfilled` */
  code: string;
}

/** Dividend-risk evidence for one open short call at a snapshot before an ex-date. */
export interface DividendRiskRow {
  tradeId: number;
  legIndex: number;
  underlying: string;
  exDate: string;
  dividend: number;
  /** The call's extrinsic value per share at the snapshot. */
  extrinsic: number;
  /** True when the dividend exceeds the extrinsic value — the classic early-assignment condition. */
  atRisk: boolean;
}

/** The volatility surface's evolution, one row per snapshot (bounded by the snapshot count). */
export interface SurfaceRow {
  asOf: EpochMs;
  /** At-the-money implied volatility per listed expiry (the nearest strike to spot with a volatility). */
  atTheMoneyVolatilityByExpiry: Record<string, number>;
  /** IV(25Δ put) − IV(25Δ call) of the nearest listed expiry, or `null` when the chain carries no deltas. */
  skew25Delta: number | null;
  /** Where this snapshot's leg marks came from, across every open trade. */
  markSources: TradeMarkCounts;
  dividendRisk: DividendRiskRow[];
}

/** Applied conventions, echoed (the envelope law). */
export interface OptionsBacktestAssumptions {
  conventionsVersion: string;
  initialCapital: number;
  riskFreeRate: number;
  dividendYield: number;
  /** Fill price source for entries/exits. */
  priceSource: PriceSource;
  /** How positions were sized. */
  sizing: 'fixed-quantity' | 'margin-aware';
  commission: string;
  slippage: string;
  assignment: 'model' | 'none';
  /** Delta-hedge band in share-equivalents, or `'none'`. */
  hedge: number | 'none';
  periodsPerYear: number;
  /** The applied marking and missing-mark policies (Preview P1). */
  marking: AppliedMarkingPolicy;
  /** Stage 4.6: the book, the limits, the fill policy, the freshness policy, and the rules. */
  book: { maximumOpenPositions: number; maximumPerUnderlying: number | null };
  limits: {
    maximumMarginFraction: number | null;
    maximumNetDelta: number | null;
    maximumNetVega: number | null;
    maximumConcentration: number | null;
    scenarioLoss: {
      spotShocks: number[];
      volatilityShocks: number[];
      maximumLossFraction: number;
    } | null;
  };
  fillPolicy: { mode: 'combo' | 'legged'; partialFill: 'reject' | 'allow'; price: PriceSource };
  quoteFreshness: { maximumQuoteAgeMs: number | null };
  rules: Array<{ id: string; structure: string }>;
  corporateActions: number;
  dividends: number;
  baseCurrency: string;
  ledger: { sourceId: string; accountId: string; lotRelief: string };
  /** `false` exactly when a caller function (a `build`, a `when`) participated. */
  replayable: boolean;
}

/** The result of an options backtest. */
export interface OptionsBacktestResult {
  points: EquityPoint[];
  returns: number[];
  trades: OptionsTrade[];
  settlements: OptionSettlement[];
  /** Every fill the book placed — the same `NormalizedFill`s the ledger folded (Decision 2). */
  fills: NormalizedFill[];
  finalValue: number;
  performance: PerformanceSummary;
  assumptions: OptionsBacktestAssumptions;
  diagnostics: OptionsBacktestDiagnostics;
  /** Stage 4.6: the book's rows and the ledger. */
  limitRejections: LimitRejection[];
  fillRejections: FillRejection[];
  surface: SurfaceRow[];
  ledger: PortfolioLedgerSnapshot;
  timeline: PortfolioTimelineResult;
  /** Content-addressed identity of the request (callbacks recorded as such). */
  runId: string;
}

export interface OptionsBacktestDiagnostics extends Diagnostics {
  snapshotCount: number;
  tradeCount: number;
  openAtEnd: number;
  limitRejectionCount: number;
  fillRejectionCount: number;
  earlyAssignmentCount: number;
  corporateActionsApplied: number;
  /** The ledger's NAV minus the engine's equity at the worst mark — always 0 within 1e-6. */
  reconciliationResidual: number;
}
