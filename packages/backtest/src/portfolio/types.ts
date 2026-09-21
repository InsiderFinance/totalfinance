/**
 * `@totalfinance/backtest/portfolio` — types for `portfolioBacktest`, the ledger-backed multi-asset
 * simulator (Stage 4.6, FC8 Decision 6). Every fill, flow, lifecycle fact, and liquidation is a
 * portfolio event folded through `@totalfinance/portfolio`'s reducer; the equity at every mark is the
 * ledger's net asset value.
 */

import type {
  Bar,
  CorporateAction,
  Diagnostics,
  EpochMs,
  OrderBook,
  Quote,
  Trade,
} from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import type {
  AllocationTarget,
  CurrencyPairQuote,
  DerivativeContractTerms,
  InstrumentClassification,
  InvestmentPolicy,
  LotReliefPolicy,
  ModelPortfolio,
  NormalizedFill,
  PortfolioEvent,
  PortfolioEventEnvelope,
  PortfolioLedgerSnapshot,
  PortfolioPnlResult,
  PortfolioSnapshotResult,
  PortfolioState,
  PortfolioTimelineResult,
  PortfolioValuationMark,
  RebalanceScope,
} from '@totalfinance/portfolio';
import type { PerformanceSummary } from '@totalfinance/performance';
import type { EquityPoint } from '../types.js';
import type {
  ExecutionPolicy,
  ExecutionPolicyDescription,
  OrderIntent,
} from '../execution/types.js';
import type { ChainSnapshot, MissingMarkCause } from '../options/types.js';
import type { RebalanceFrequency } from '../cross-sectional/types.js';
import type { WarningCode } from '@totalfinance/core';

/** The instrument kinds with a built-in adapter, plus `custom`. */
export type InstrumentKind =
  | 'equity'
  | 'etf'
  | 'option'
  | 'future'
  | 'fx-forward'
  | 'crypto-spot'
  | 'crypto-perpetual'
  | 'bond'
  | 'custom';

/** The asset classes the accounting's settlement table and the classifications name. */
export type AssetClass = InstrumentKind | 'cash';

/** A bond's coupon terms — accrued interest is computed from these, never fetched. */
export interface CouponTerms {
  /** Annual coupon rate, decimal (0.05 = 5%). */
  annualRate: number;
  /** Coupons per year (1, 2, 4, 12). */
  paymentsPerYear: number;
  /** Face value per unit of quantity (default 1). */
  faceValuePerUnit?: number;
  /** Accrual day count (default `'ACT/365F'`). */
  dayCount?: 'ACT/365F' | '30/360';
  /** Dated date / first accrual date, `YYYY-MM-DD`. */
  issueDate: string;
  /** Maturity, `YYYY-MM-DD`; principal redeems at the face value on this date. */
  maturityDate: string;
}

/** A forward contract on a currency pair, marked from a caller-supplied forward-rate series. */
export interface ForwardTerms {
  maturityTimestampMs: EpochMs;
  /** The currency bought forward (one unit of quantity = one unit of this currency). */
  baseCurrency: string;
  /** The currency paid, at `contractRate` per base unit. */
  quoteCurrency: string;
  contractRate: number;
}

/** A future's declared roll: the successor contract and how many sessions before expiry to roll. */
export interface RollTerms {
  toInstrumentId: string;
  sessionsBeforeExpiry: number;
}

export interface InstrumentSpecification {
  kind: InstrumentKind;
  /** The trading and mark currency. */
  currency: string;
  /** Units of the underlying per unit of quantity (an option's 100, a futures contract size); default 1. */
  contractMultiplier?: number;
  /** REQUIRED for `option`, `future`, and `crypto-perpetual` — the ledger stores the terms on the position. */
  contract?: DerivativeContractTerms;
  /** Default: the kind. */
  assetClass?: AssetClass;
  classification?: InstrumentClassification;
  /** REQUIRED for `custom`; refused for a built-in kind. */
  adapter?: InstrumentAdapter;
  /** `future`: the declared roll. */
  roll?: RollTerms;
  /** `bond`: the coupon terms. */
  coupon?: CouponTerms;
  /** `fx-forward`: the contract. */
  forward?: ForwardTerms;
}

/** The latest observation of each kind at or before the instant, per instrument. */
export interface LatestObservations {
  bar?: Bar;
  quote?: Quote;
  trade?: Trade;
  orderBook?: OrderBook;
  /** The option contract's chain quote at the instant (options). */
  chainQuote?: ChainSnapshot['quotes'][number];
  /** The underlying's spot at the instant (options), from the chain snapshot. */
  underlyingPrice?: number;
  /** The forward rate at the instant (fx-forward). */
  forwardRate?: number;
}

export interface MarkInput {
  instrumentId: string;
  specification: InstrumentSpecification;
  asOf: EpochMs;
  latest: LatestObservations;
  /** The previous mark, when one exists. */
  previous: { pricePerUnit: number; source: string } | null;
}

export type MarkOutcome =
  | { pricePerUnit: number; source: string }
  | { unavailable: MissingMarkCause };

export interface DividendRecord {
  /** The instrument the dividend is paid on. */
  instrumentId: string;
  exDate: string;
  /** Per unit of quantity, > 0. */
  amount: number;
  /** Default: the ex-date. */
  payDate?: string;
}

export interface CouponRecord {
  instrumentId: string;
  paymentDate: string;
  /** Per unit of quantity, > 0. */
  amountPerUnit: number;
}

export interface FundingRateRecord {
  instrumentId: string;
  timestampMs: EpochMs;
  /** The funding rate for the interval ending at the instant; positive = longs pay shorts. */
  fundingRate: number;
}

export interface ForwardRateRecord {
  instrumentId: string;
  timestampMs: EpochMs;
  /** Quote currency per base unit for the instrument's maturity. */
  forwardRate: number;
}

/** A dated FX quote to the base currency. */
export interface DatedCurrencyPairQuote {
  timestampMs: EpochMs;
  baseCurrency: string;
  quoteCurrency: string;
  quotePerBase: number;
}

/** The facts an adapter's lifecycle sees for one instrument in `(previousAsOf, asOf]`. */
export interface LifecycleFacts {
  dividends: readonly DividendRecord[];
  coupons: readonly CouponRecord[];
  fundingRates: readonly FundingRateRecord[];
  corporateActions: readonly CorporateAction[];
}

export interface LifecycleInput {
  instrumentId: string;
  specification: InstrumentSpecification;
  asOf: EpochMs;
  previousAsOf: EpochMs | null;
  /** The held position, or `null` when flat. */
  held: { quantity: number; contractMultiplier: number } | null;
  /** The instrument's mark at the instant, when one exists. */
  mark: { pricePerUnit: number; source: string } | null;
  /** The underlying's mark at the instant (options, futures, perpetuals), when one exists. */
  underlyingMark: number | null;
  facts: LifecycleFacts;
  /** True when this instant is the last one the run sees. */
  last: boolean;
}

/** The fill terms an adapter stamps on every fill of its instrument. */
export type FillTerms = Pick<NormalizedFill, 'settlementStyle' | 'contractMultiplier' | 'contract'>;

/**
 * An instrument adapter: how the instrument marks, which lifecycle facts it emits (as FC7 event
 * PAYLOADS — the engine envelopes them with ids, the source, and the instant), and how its fills
 * settle. Pure and deterministic; `assertInstrumentAdapterConformance` proves it.
 */
export interface InstrumentAdapter {
  readonly kind: string;
  readonly version: string;
  mark(input: MarkInput): MarkOutcome;
  lifecycle(input: LifecycleInput): PortfolioEvent[];
  fillTerms(specification: InstrumentSpecification): FillTerms;
  /** Accrued interest per unit at the instant (bonds); omitted = none. */
  accrued?(input: { specification: InstrumentSpecification; asOf: EpochMs }): number;
}

export interface AccountingPolicy {
  baseCurrency: string;
  initialCash: readonly { currency: string; amount: number }[];
  /** Default `'fifo'`. */
  lotRelief?: LotReliefPolicy;
  /** Settlement lag per asset class; default equities/etf/option/bond `'T+1'`, everything else `'T+0'`. */
  settlement?: Partial<Record<AssetClass, 'T+0' | 'T+1' | 'T+2'>>;
}

export interface PortfolioMarketData {
  bars?: readonly Bar[];
  quotes?: readonly Quote[];
  trades?: readonly Trade[];
  orderBooks?: readonly OrderBook[];
  optionChains?: readonly ChainSnapshot[];
  /** Dated quotes to the base currency; REQUIRED when any instrument's currency ≠ baseCurrency. */
  fxRates?: readonly DatedCurrencyPairQuote[];
  /** Forward-rate series per fx-forward instrument. */
  forwardRates?: readonly ForwardRateRecord[];
  fundingRates?: readonly FundingRateRecord[];
  corporateActions?: readonly CorporateAction[];
  dividends?: readonly DividendRecord[];
  coupons?: readonly CouponRecord[];
}

export interface SessionPosition {
  instrumentId: string;
  quantity: number;
  contractMultiplier: number;
  /** `quantity × mark × multiplier` in the base currency, signed; null while the instrument has no mark (Stage 7B.1). */
  baseCurrencyMarketValue: number | null;
  /** The mark per unit at the instant, or `null` when unavailable. */
  markPricePerUnit: number | null;
  currency: string;
}

/** What a direct strategy sees at a decision instant. */
export interface SessionContext {
  asOf: EpochMs;
  index: number;
  netAssetValue: number;
  cash: readonly { currency: string; amount: number }[];
  positions: readonly SessionPosition[];
  /** The latest observations per instrument at the instant. */
  observations: Readonly<Record<string, LatestObservations>>;
  /** Each instrument's mark at the instant from its adapter, or null when the adapter has none (Stage 7B.1). */
  marks: Readonly<Record<string, { pricePerUnit: number; source: string } | null>>;
  instruments: Readonly<Record<string, InstrumentSpecification>>;
}

/** The FC7 valuation inputs at an instant — what `portfolioSnapshot` and `monitorPortfolio` take (Stage 7B.1). */
export interface PortfolioValuationInputs {
  asOf: EpochMs;
  portfolio: PortfolioState;
  market: MarketSnapshot;
  currencyConversions: CurrencyPairQuote[];
  snapshot: PortfolioSnapshotResult;
}

export interface RebalanceSchedule {
  frequency: RebalanceFrequency;
}

export type PortfolioStrategy =
  | {
      /** A model artifact or inline targets, proposed on the schedule through `proposePortfolioRebalance`. */
      model: ModelPortfolio | readonly AllocationTarget[];
      schedule: RebalanceSchedule;
      policy?: InvestmentPolicy;
      /** Default `'to-target'`. */
      scope?: RebalanceScope;
    }
  | {
      /** Direct TypeScript; the run is not replayable. */
      onSession: (context: SessionContext) => readonly OrderIntent[];
    };

export interface ExternalFlowRecord {
  timestampMs: EpochMs;
  /** Contribution (> 0) or withdrawal (< 0). */
  amount: number;
  currency: string;
}

/** Everything a run needs except who decides the orders — the stepper's request (Stage 7B.1). */
export interface PortfolioStepperRequest {
  accounting: AccountingPolicy;
  instruments: Readonly<Record<string, InstrumentSpecification>>;
  marketData: PortfolioMarketData;
  execution?: ExecutionPolicy;
  externalFlows?: readonly ExternalFlowRecord[];
  /** A calendar name (`'NYSE'`, `'CBOE'`, `'ALWAYS_OPEN'`): sessions and settlement days. */
  calendar?: string;
  window?: { fromTimestampMs?: EpochMs; toTimestampMs?: EpochMs };
  periodsPerYear?: number;
  /** Seeds only the bootstrap confidence intervals. */
  seed?: number;
}

export interface PortfolioBacktestRequest extends PortfolioStepperRequest {
  strategy: PortfolioStrategy;
}

export type OrderSource = 'strategy' | 'lifecycle' | 'liquidation';

export interface OrderRecord {
  orderId: string;
  asOf: EpochMs;
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: OrderIntent['type'];
  source: OrderSource;
  outcome: 'filled' | 'partial' | 'unfilled';
  filledQuantity: number;
  reason: string | null;
}

export interface RejectionRow {
  asOf: EpochMs;
  orderId: string | null;
  instrumentId: string;
  /** `backtest.limit_rejected` | the fill model's unfilled reason | `backtest.stale_quote` … */
  code: string;
  detail: string;
}

export interface LiquidationRow {
  asOf: EpochMs;
  policy: 'close-largest-loss' | 'pro-rata';
  instrumentId: string;
  quantity: number;
  shortfall: number;
  code: typeof WarningCode.BacktestForcedLiquidation;
}

export interface PortfolioBacktestAssumptions {
  conventionsVersion: string;
  baseCurrency: string;
  lotRelief: LotReliefPolicy;
  settlement: Record<string, 'T+0' | 'T+1' | 'T+2'>;
  calendar: string | null;
  sessionConvention: string;
  markConvention: string;
  strategy:
    | {
        kind: 'model';
        modelId: string | null;
        targets: number;
        frequency: RebalanceFrequency;
        scope: RebalanceScope;
      }
    | { kind: 'callback'; replayable: false }
    /** The orders came from a stepper's caller step by step (Stage 7B.1). */
    | { kind: 'external'; replayable: false };
  execution: ExecutionPolicyDescription;
  instruments: Array<{
    instrumentId: string;
    kind: InstrumentKind;
    adapter: { kind: string; version: string };
    currency: string;
  }>;
  periodsPerYear: number;
  seed: number | null;
  window: { fromTimestampMs: EpochMs | null; toTimestampMs: EpochMs | null };
  ledger: { sourceId: string; accountId: string };
  replayable: boolean;
}

export interface PortfolioBacktestDiagnostics extends Diagnostics {
  sessionCount: number;
  orderCount: number;
  fillCount: number;
  rejectionCount: number;
  liquidationCount: number;
  lifecycleEventCount: number;
  externalFlowCount: number;
  markCount: number;
  /** The ledger NAV minus the engine's equity at the worst mark — always 0 within 1e-6. */
  reconciliationResidual: number;
}

export interface PortfolioBacktestResult {
  ledger: PortfolioLedgerSnapshot;
  timeline: PortfolioTimelineResult | null;
  pnl: PortfolioPnlResult | null;
  orders: OrderRecord[];
  fills: NormalizedFill[];
  rejections: RejectionRow[];
  liquidations: LiquidationRow[];
  events: PortfolioEventEnvelope[];
  valuationMarks: PortfolioValuationMark[];
  points: EquityPoint[];
  returns: number[];
  performance: PerformanceSummary;
  finalValue: number;
  runId: string;
  assumptions: PortfolioBacktestAssumptions;
  diagnostics: PortfolioBacktestDiagnostics;
}

/** The rows one closed instant appended (Stage 7B.1): what the step did, in the engine's own grammar. */
export interface PortfolioStepFrame {
  asOf: EpochMs;
  index: number;
  /** The ledger's net asset value after the step, in the base currency. */
  netAssetValue: number;
  orders: OrderRecord[];
  fills: NormalizedFill[];
  rejections: RejectionRow[];
  liquidations: LiquidationRow[];
  /** Every portfolio event folded during the step — lifecycle, flows, fills, liquidations. */
  events: PortfolioEventEnvelope[];
  warnings: QuantWarning[];
}

/** `portfolioBacktest`'s loop driven from outside (Stage 7B.1, Decision 2). */
export interface PortfolioStepper {
  readonly runId: string;
  /** The decision instants, ascending — the same instants `portfolioBacktest` would step. */
  readonly instants: readonly EpochMs[];
  /** Lifecycle facts and external flows due at the instant, then the session context. */
  open(index: number): SessionContext;
  /** The orders through the execution policy, the margin check, the valuation mark, the equity. */
  close(index: number, orders: readonly OrderIntent[]): PortfolioStepFrame;
  /** The session context at the last closed instant — the state after its orders, margin, and mark. */
  context(): SessionContext;
  /** The ledger state, the market snapshot, the conversions, and the valued snapshot at the last closed instant. */
  valuation(): PortfolioValuationInputs;
  /** The same result `portfolioBacktest` returns, over the instants closed so far. */
  finish(): PortfolioBacktestResult;
}
