/**
 * The chain-driven options-strategy backtest engine over a position BOOK (Stage 4.6, FC8 Decision 5).
 *
 * Composes proven primitives — `strategyFromChain` and the calendar/diagonal constructors (entry),
 * `Position.value()` (marking + per-leg greeks), `optionsMargin` / `aggregateGreeks` / `scenarioGrid`
 * (sizing and the pre-trade limits) — over a time series of `ChainSnapshot`s. Several rules may hold
 * several trades at once; every fill, settlement, and adjustment is a portfolio-ledger event and the
 * reported equity reconciles to the ledger's NAV. No look-ahead (each snapshot sees only its own
 * chain), no silent degradation (an unbuildable entry discloses and skips; a rejected entry is a row),
 * and every result carries the `assumptions` + `diagnostics` envelope. With one rule and the default
 * book of one, the engine is exactly the shipped single-position backtester.
 */

import {
  validateClosedRequest,
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type EpochMs,
  type PriceSource,
  type QuantWarning,
  formatOccSymbol,
  isQuantError,
  isoDateToEpochMs,
  optionExpiryToMs,
  yearFraction,
  sideOf,
  type OrderSide,
  WarningCode,
} from '@totalfinance/core';
import type { ClosedRequestSpecification, OptionQuote } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import { VALIDATION_SPECS } from '../generated/validation-specs.js';
import { selectQuotePrice } from '@totalfinance/options';
import { blackScholesImpliedVolatility } from '@totalfinance/options/black-scholes';
import { Position, type Leg } from '@totalfinance/strategy';
import {
  aggregateGreeks,
  explainPositionPnl,
  optionsMargin,
  scenarioGrid,
  type OptionMarginLeg,
  type PnlMarket,
} from '@totalfinance/risk';
import { analyze } from '@totalfinance/performance';
import {
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioEventsFromFill,
  portfolioSnapshot,
  portfolioTimeline,
  type NormalizedFill,
  type PortfolioEventEnvelope,
  type PortfolioState,
  type PortfolioTimelineResult,
  type PortfolioValuationMark,
} from '@totalfinance/portfolio';
import { type CostModel, type SlippageModel, fees, slippage as slippageModels } from '../costs.js';
import { toEquityPoints, type EquityPoint, type OptionSettlement } from '../types.js';
import { buildEntryPosition, daysToExpiry, requireSnapshot, snapshotAsOf } from './chain.js';
import type {
  AppliedMarkingPolicy,
  ChainSnapshot,
  DividendRiskRow,
  EntryContext,
  EntryRule,
  ExitContext,
  ExitReason,
  ExitRule,
  FillRejection,
  LegAttribution,
  LimitRejection,
  MarkSource,
  MissingMarkCause,
  OpenTradeView,
  OptionsBacktestConfig,
  OptionsBacktestResult,
  OptionsTrade,
  PortfolioLimits,
  SurfaceRow,
  TradeLineage,
  TradeMarkCounts,
  TradePnlExplain,
  UnfilledLeg,
} from './types.js';

const FN = 'optionsBacktest';
const ACCOUNT_ID = 'main';
const DAY_MS = 86_400_000;
const RECONCILIATION_TOLERANCE = 1e-9;

/** A quote's identity for order-invariant hashing: the contract it prices and its print time. */
const quoteIdentityKey = (q: OptionQuote): string =>
  `${q.contract.expiry}|${q.contract.strike}|${q.contract.type}|${q.contract.underlying ?? ''}|${q.timestampMs ?? ''}`;
/** Decision 9: open positions one book may hold. */
export const OPTIONS_BOOK_CEILING = 10_000;

/** Generated closed-request spec (3B.1b): the allowlist tree projected from the declaration. */
function specOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `optionsBacktest: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const OPTIONS_BACKTEST_SPEC = specOf('optionsBacktest#0');

/** One leg of an open trade with its ledger identity and mark memory. */
interface TradeLeg {
  leg: Leg;
  /** Index in the trade's ORIGINAL leg list (the `legs` a trade row reports). */
  originalIndex: number;
  instrumentId: string;
  entryVolatility: number | undefined;
  lastVolatility: number | undefined;
}

interface OpenTrade {
  tradeId: number;
  ruleId: string;
  ruleIndex: number;
  underlying: string;
  structure: string;
  /** The live position — the legs not yet settled. */
  position: Position;
  /** The live legs, aligned to `position.legs`. */
  live: TradeLeg[];
  /** Every leg the trade ever held, in original order. */
  originalLegs: Leg[];
  originalInstrumentIds: string[];
  entryAsOf: EpochMs;
  /** Signed net premium at entry (positive debit / negative credit), account currency. */
  entryPremium: number;
  contracts: number;
  entryCosts: number;
  /** Underlying spot at entry — the anchor for the trade's greek P&L explain (entry → exit). */
  entrySpot: number;
  /** Position-level ATM vol at entry (fallback for legs without their own IV); `undefined` when the
   *  entry chain carried no IV and every leg priced off its own. */
  entryVolatility: number | undefined;
  /** The current-snapshot marks of this trade, computed once per snapshot (Preview P1). */
  markCache: { snap: ChainSnapshot; legVolatilities: (number | undefined)[] } | null;
  marks: TradeMarkCounts;
  /** Fallback leg-snapshots per cause, for the one-warning-per-cause disclosure at close. */
  fallbacks: Map<MissingMarkCause, number>;
  /** P&L already realized by legs that settled before the close (cash at intrinsic, basis relieved). */
  settledPnl: number;
  legSettlements: Array<{ legIndex: number; settlement: OptionSettlement }>;
  lineage: TradeLineage[];
  partial: boolean;
  unfilledLegs: UnfilledLeg[];
}

/** One leg's current-snapshot mark resolution (Preview P1). */
type LegMark =
  | { volatility: number; source: MarkSource }
  | { cause: MissingMarkCause }
  | { intrinsic: true };

const MISSING_MARK_TEACHING: Record<MissingMarkCause, string> = {
  missing: 'the snapshot carries no quote for this contract',
  ambiguous: 'the snapshot carries more than one quote for this contract',
  stale: "the contract's quote is older than marking.maximumQuoteAgeMs",
  unpriceable:
    'the quote states no usable implied volatility and its price cannot be inverted (no price under the request priceSource, or a price below intrinsic)',
};

// ── module-level pure helpers ─────────────────────────────────────────────────────────────────────

/** Per-contract dollar price from a per-share premium and the multiplier. */
function perContract(premiumPerShare: number, multiplier: number): number {
  return Math.abs(premiumPerShare) * multiplier;
}

interface CostPieces {
  commission: number;
  slippageAdjustment: number;
}

/** Commission + slippage for one leg at contract granularity, kept apart for the ledger's cost rows. */
function legCost(
  contracts: number,
  perContractPrice: number,
  side: OrderSide,
  commission: CostModel,
  slippage: SlippageModel,
): CostPieces {
  if (contracts === 0) return { commission: 0, slippageAdjustment: 0 };
  return {
    commission: commission.commission({ quantity: contracts, price: perContractPrice }),
    slippageAdjustment:
      Math.abs(
        slippage.fill({ referencePrice: perContractPrice, side, quantity: contracts }) -
          perContractPrice,
      ) * contracts,
  };
}

const totalCost = (pieces: readonly CostPieces[]): number =>
  pieces.reduce((sum, p) => sum + p.commission + p.slippageAdjustment, 0);

function positionExpiries(position: Position): string[] {
  const set = new Set<string>();
  for (const l of position.legs) if (l.expiry !== undefined) set.add(l.expiry);
  return [...set];
}

/** Days to the NEAREST leg expiry (the first to settle). */
function minDaysToExpiry(position: Position, asOfMs: EpochMs): number {
  const expiries = positionExpiries(position);
  if (expiries.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...expiries.map((e) => daysToExpiry(asOfMs, e)));
}

/** Evaluate one exit rule against the current mark; return the firing reason or null. */
function evaluateExit(rule: ExitRule, context: ExitContext): ExitReason | null {
  if (rule.profitTarget !== undefined && context.pnlFraction >= rule.profitTarget)
    return 'profit-target';
  if (rule.stopLoss !== undefined && context.pnlFraction <= -rule.stopLoss) return 'stop-loss';
  if (rule.daysToExpiry !== undefined && context.daysToExpiry <= rule.daysToExpiry)
    return 'daysToExpiry';
  if (rule.when !== undefined && rule.when(context)) return 'signal';
  return null;
}

/** The guarded fallback: book the whole gross P&L to the residual so the attribution still sums. */
function unexplainedTradeExplain(grossPnl: number): TradePnlExplain {
  return {
    total: grossPnl,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    rho: 0,
    vanna: 0,
    vomma: 0,
    charm: 0,
    veta: 0,
    vera: 0,
    deltaRate: 0,
    thetaRate: 0,
    rhoConvexity: 0,
    thetaConvexity: 0,
    phi: 0,
    unexplained: grossPnl,
  };
}

/**
 * The trade's greek P&L explain (entry → exit) via `explainPositionPnl` over the LIVE legs. `total` is
 * anchored to the trade's ACTUAL gross (pre-cost) P&L, so the entry edge and any P&L realized by legs
 * that settled earlier are folded into `unexplained` — model/data and settlement effects, not
 * market-move greeks; the sums stay invariant (`Σterms + unexplained === total`).
 */
function tradePnlExplain(input: {
  position: Position;
  entry: {
    asOf: EpochMs;
    spot: number;
    volatility: number | undefined;
    legVolatilities?: readonly (number | undefined)[];
  };
  exit: {
    asOf: EpochMs;
    spot: number;
    volatility: number | undefined;
    legVolatilities?: readonly (number | undefined)[];
  };
  riskFreeRate: number;
  dividendYield: number;
  grossPnl: number;
}): TradePnlExplain {
  const { position, entry, exit, riskFreeRate, dividendYield, grossPnl } = input;
  const market = (m: {
    asOf: EpochMs;
    spot: number;
    volatility: number | undefined;
    legVolatilities?: readonly (number | undefined)[];
  }): PnlMarket => ({
    spot: m.spot,
    riskFreeRate,
    asOf: m.asOf,
    dividendYield,
    ...(m.volatility !== undefined ? { volatility: m.volatility } : {}),
    ...(m.legVolatilities !== undefined ? { legVolatilities: m.legVolatilities } : {}),
  });
  try {
    if (position.legs.length === 0) return unexplainedTradeExplain(grossPnl);
    const {
      assumptions: _assumptions,
      diagnostics: _diagnostics,
      perLeg: _perLeg,
      ...terms
    } = explainPositionPnl({ position, from: market(entry), to: market(exit) });
    const edge = grossPnl - terms.total;
    return { ...terms, total: grossPnl, unexplained: terms.unexplained + edge };
  } catch {
    return unexplainedTradeExplain(grossPnl);
  }
}

/** Reg-T initial margin of a position's option legs (share-scaled by the risk package). */
function optionMargin(position: Position, spot: number): number {
  const optionLegs: OptionMarginLeg[] = position.legs
    .filter((l): l is Leg & { kind: 'call' | 'put' } => l.kind === 'call' || l.kind === 'put')
    .map((l) => ({ type: l.kind, quantity: l.quantity, strike: l.strike, premium: l.premium }));
  if (optionLegs.length === 0) return 0;
  const hasStock = position.legs.some((l) => l.kind === 'stock');
  const expiries = new Set(
    position.legs.filter((l) => l.kind !== 'stock' && l.expiry !== undefined).map((l) => l.expiry),
  );
  if (hasStock && expiries.size <= 1) {
    const maxLoss = position.metrics().maxLoss;
    if (maxLoss !== null) return Math.max(0, -maxLoss);
  }
  return optionsMargin(optionLegs, { spot, multiplier: position.multiplier }).initialMargin;
}

/**
 * The instant to mark a settling position: the latest **expired** leg's expiry moment (≥ `asOf`), so
 * those legs price at true intrinsic (t ≤ 0) while any not-yet-expired (calendar/diagonal) leg keeps
 * its remaining time value.
 */
function settlementInstant(position: Position, asOfMs: EpochMs): EpochMs {
  let instant = asOfMs;
  for (const leg of position.legs) {
    if (leg.kind === 'stock' || leg.expiry === undefined) continue;
    if (daysToExpiry(asOfMs, leg.expiry) > 0) continue;
    const legInstant = optionExpiryToMs(leg.expiry);
    if (legInstant > instant) instant = legInstant;
  }
  return instant;
}

/** A proxy "lot count" for a custom-built position: the largest per-leg option contract count. */
function maxLotOf(position: Position): number {
  let max = 1;
  for (const l of position.legs) if (l.kind !== 'stock') max = Math.max(max, Math.abs(l.quantity));
  return max;
}

/** Simple per-period returns from an equity curve (length n+1 → n returns). */
function simpleReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    out.push(prev === 0 ? 0 : equity[i]! / prev - 1);
  }
  return out;
}

function intrinsicOf(kind: 'call' | 'put', spot: number, strike: number): number {
  return kind === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

/** The calendar date (`YYYY-MM-DD`, UTC) of an instant. */
function dateOf(ms: EpochMs): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}
function nextCalendarDate(date: string): string {
  return new Date(isoDateToEpochMs(date) + DAY_MS).toISOString().slice(0, 10);
}

/** An OCC-style instrument id for an option leg (the ledger's key), or the underlying for stock. */
function legInstrumentId(underlying: string, leg: Leg, expiry: string | undefined): string {
  if (leg.kind === 'stock') return underlying;
  // A `build` leg without an expiry never settles and cannot carry option terms; it still needs an
  // id of its own so the ledger never confuses it with the underlying.
  if (expiry === undefined) return `${underlying}:${leg.kind}:${leg.strike}`;
  return formatOccSymbol({ root: underlying, expiry, type: leg.kind, strike: leg.strike });
}

/** The rules of a request: one rule, or the book's rules in order. */
function rulesOf(config: OptionsBacktestConfig): readonly EntryRule[] {
  return config.rules ?? (config.entry === undefined ? [] : [config.entry]);
}

/** The identity of the request: every declarative member; callbacks recorded as such. */
function identityOf(
  config: OptionsBacktestConfig,
  rules: readonly EntryRule[],
): Record<string, unknown> {
  const rule = (r: EntryRule): unknown =>
    'build' in r
      ? { build: 'callback', when: typeof r.when === 'function' ? 'callback' : (r.when ?? 'flat') }
      : { ...r, when: typeof r.when === 'function' ? 'callback' : (r.when ?? 'flat') };
  return {
    rules: rules.map(rule),
    entryForm: config.rules === undefined ? 'entry' : 'rules',
    exit: { ...config.exit, when: config.exit.when === undefined ? undefined : 'callback' },
    roll:
      config.roll === undefined
        ? null
        : {
            when:
              config.roll.when === undefined
                ? null
                : {
                    ...config.roll.when,
                    when: config.roll.when.when === undefined ? undefined : 'callback',
                  },
          },
    hedge:
      config.hedge === undefined
        ? null
        : {
            deltaBand: config.hedge.deltaBand,
            commission: config.hedge.commission?.label ?? null,
            slippage: config.hedge.slippage?.label ?? null,
          },
    marking: config.marking ?? null,
    initialCapital: config.initialCapital ?? 100_000,
    riskFreeRate: config.riskFreeRate,
    dividendYield: config.dividendYield ?? 0,
    commission: config.commission?.label ?? 'none',
    slippage: config.slippage?.label ?? 'none',
    assignment: config.assignment ?? 'none',
    periodsPerYear: config.periodsPerYear ?? 252,
    book: config.book ?? null,
    limits: config.limits ?? null,
    fillPolicy: config.fillPolicy ?? null,
    quoteFreshness: config.quoteFreshness ?? null,
    corporateActions: config.corporateActions ?? [],
    dividends: config.dividends ?? [],
    baseCurrency: config.baseCurrency ?? 'USD',
  };
}

// ── the engine ──────────────────────────────────────────────────────────────────────────────────

/**
 * Run a chain-driven options-strategy backtest over a position book. See
 * `docs/specs/options-backtest.md` and `docs/specs/portfolio-scale-backtesting.md` (Decision 5).
 */
/**
 * The closed guard for `optionsBacktest` (Stage 4.6): the generated closed-request spec over the
 * whole declaration, then the hand laws — the iterable `chains`, the rules and their unique ids, the
 * book's bounds, the limits, the fill and freshness policies, the corporate actions, the dividends.
 * `optionsBacktest` calls it first; the run artifacts call it before storing a request.
 */
export function requireOptionsBacktestConfig(
  functionName: string,
  label: string,
  value: unknown,
): void {
  validateClosedRequest(functionName, value as OptionsBacktestConfig, OPTIONS_BACKTEST_SPEC, {
    argumentName: label,
    exampleCall:
      "optionsBacktest({ chains, entry: { structure: 'bullPutSpread', daysToExpiry: { target: 45, min: 30, max: 60 }, select: { shortDelta: 0.3, width: 5 } }, exit: { profitTarget: 0.5, daysToExpiry: 21 } })",
  });
  const config = value as OptionsBacktestConfig;
  const refuse = (
    field: string,
    message: string,
    code: string = ErrorCode.InputOutOfRange,
  ): never => {
    throw new InputError(`${functionName}: ${label}.${field} ${message}`, {
      code,
      context: { function: functionName, field: `${label}.${field}` },
    });
  };
  if (
    config.chains === null ||
    typeof config.chains !== 'object' ||
    typeof (config.chains as Iterable<unknown>)[Symbol.iterator] !== 'function'
  ) {
    refuse('chains', 'must be an iterable of ChainSnapshot.', ErrorCode.InputWrongType);
  }
  if (config.riskFreeRate === undefined || config.riskFreeRate === null) {
    refuse(
      'riskFreeRate',
      'is required — the continuously-compounded rate (decimal, e.g. 0.045) that prices every mark and the assignment carry. The engine never assumes a rate.',
      ErrorCode.InputMissingField,
    );
  }
  if (typeof config.riskFreeRate !== 'number' || !Number.isFinite(config.riskFreeRate)) {
    refuse('riskFreeRate', 'must be a finite decimal rate.', ErrorCode.InputWrongType);
  }
  const maximumQuoteAgeMs = config.marking?.maximumQuoteAgeMs ?? null;
  if (
    maximumQuoteAgeMs !== null &&
    (!Number.isFinite(maximumQuoteAgeMs) || maximumQuoteAgeMs < 0)
  ) {
    refuse(
      'marking.maximumQuoteAgeMs',
      `must be a finite number of milliseconds ≥ 0 (omit it to treat every quote a snapshot carries as current). Received ${String(maximumQuoteAgeMs)}.`,
    );
  }
  const hasEntry = config.entry !== undefined;
  const hasRules = config.rules !== undefined;
  if (hasEntry === hasRules) {
    refuse(
      hasEntry ? 'rules' : 'entry',
      hasEntry
        ? 'and entry were both given — one rule goes in entry, several in rules, never both.'
        : 'or rules must be given — one rule in entry, several in rules.',
      hasEntry ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
    );
  }
  const rules: readonly EntryRule[] = rulesOf(config);
  if (rules.length === 0) refuse('rules', 'must name at least one rule.');
  const ids = rules.map((rule, index) => rule.id ?? `rule-${index}`);
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index)
      refuse(`entry[${index}].id`, `repeats '${id}' — ids are unique.`);
  });
  const maximumOpenPositions = config.book?.maximumOpenPositions ?? 1;
  if (!Number.isSafeInteger(maximumOpenPositions) || maximumOpenPositions < 1) {
    refuse(
      'book.maximumOpenPositions',
      `must be a positive integer. Received ${String(maximumOpenPositions)}.`,
    );
  }
  if (maximumOpenPositions > OPTIONS_BOOK_CEILING) {
    refuse(
      'book.maximumOpenPositions',
      `is ${maximumOpenPositions}, above the ${OPTIONS_BOOK_CEILING} open positions one synchronous book may hold.`,
      ErrorCode.BacktestBookTooLarge,
    );
  }
  const maximumPerUnderlying = config.book?.maximumPerUnderlying;
  if (
    maximumPerUnderlying !== undefined &&
    (!Number.isSafeInteger(maximumPerUnderlying) || maximumPerUnderlying < 1)
  ) {
    refuse(
      'book.maximumPerUnderlying',
      `must be a positive integer. Received ${String(maximumPerUnderlying)}.`,
    );
  }
  const limits = config.limits ?? {};
  for (const key of ['maximumMarginFraction', 'maximumConcentration'] as const) {
    const v = limits[key];
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= 1))
      refuse(`limits.${key}`, `must be a fraction in (0, 1]. Received ${String(v)}.`);
  }
  for (const key of ['maximumNetDelta', 'maximumNetVega'] as const) {
    const v = limits[key];
    if (v !== undefined && !(Number.isFinite(v) && v >= 0))
      refuse(`limits.${key}`, `must be a finite number ≥ 0. Received ${String(v)}.`);
  }
  if (limits.scenarioLoss !== undefined) {
    const sl = limits.scenarioLoss;
    if (
      !(
        Number.isFinite(sl.maximumLossFraction) &&
        sl.maximumLossFraction > 0 &&
        sl.maximumLossFraction <= 1
      )
    ) {
      refuse('limits.scenarioLoss.maximumLossFraction', 'must be a fraction in (0, 1].');
    }
    for (const [name, values] of [
      ['spotShocks', sl.spotShocks],
      ['volatilityShocks', sl.volatilityShocks],
    ] as const) {
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 64 ||
        values.some((v) => !Number.isFinite(v))
      ) {
        refuse(`limits.scenarioLoss.${name}`, 'must be 1–64 finite shocks.');
      }
    }
  }
  const fillAge = config.quoteFreshness?.maximumQuoteAgeMs;
  if (fillAge !== undefined && !(Number.isFinite(fillAge) && fillAge >= 0)) {
    refuse('quoteFreshness.maximumQuoteAgeMs', 'must be a finite number of milliseconds ≥ 0.');
  }
  (config.corporateActions ?? []).forEach((action, index) => {
    if (
      (action.type === 'split' || action.type === 'reverseSplit') &&
      !(typeof action.ratio === 'number' && Number.isFinite(action.ratio) && action.ratio > 0)
    ) {
      refuse(
        `corporateActions[${index}].ratio`,
        `is needed by a ${action.type} on ${action.symbol} (a positive ratio).`,
      );
    }
    if (
      action.type === 'symbolChange' &&
      !(typeof action.newSymbol === 'string' && action.newSymbol.length > 0)
    ) {
      refuse(
        `corporateActions[${index}].newSymbol`,
        `is needed by a symbolChange on ${action.symbol}.`,
        ErrorCode.InputMissingField,
      );
    }
  });
  (config.dividends ?? []).forEach((d, index) => {
    if (!(typeof d.amount === 'number' && Number.isFinite(d.amount) && d.amount > 0)) {
      refuse(`dividends[${index}].amount`, 'must be a positive per-share amount.');
    }
  });
}

export function optionsBacktest(config: OptionsBacktestConfig): OptionsBacktestResult {
  requireOptionsBacktestConfig(FN, 'config', config);
  const initialCapital = config.initialCapital ?? 100_000;
  const rate = config.riskFreeRate;
  const dividendYield = config.dividendYield ?? 0;
  const commission = config.commission ?? fees.none();
  const slippage = config.slippage ?? slippageModels.none();
  const assignment = config.assignment ?? 'none';
  const periodsPerYear = config.periodsPerYear ?? 252;
  const baseCurrency = config.baseCurrency ?? 'USD';
  const marking: AppliedMarkingPolicy = {
    volatility: config.marking?.volatility ?? 'current-quote',
    missingMark: config.marking?.missingMark ?? 'refuse',
    maximumQuoteAgeMs: config.marking?.maximumQuoteAgeMs ?? null,
  };
  const { exit, roll, hedge } = config;
  const hedgeCommission = hedge?.commission ?? commission;
  const hedgeSlippage = hedge?.slippage ?? slippage;

  // ---- Stage 4.6: the rules, the book, the limits, the fill and freshness policies ------------------
  const rules: readonly EntryRule[] = rulesOf(config);
  const ruleIds = rules.map((rule, index) => rule.id ?? `rule-${index}`);
  const priceSource: PriceSource = rules[0]!.price ?? 'mid';
  const maximumOpenPositions = config.book?.maximumOpenPositions ?? 1;
  const maximumPerUnderlying = config.book?.maximumPerUnderlying ?? null;
  const limits: PortfolioLimits = config.limits ?? {};
  const fillMode = config.fillPolicy?.mode ?? 'combo';
  const partialFill = config.fillPolicy?.partialFill ?? 'reject';
  const fillPrice: PriceSource = config.fillPolicy?.price ?? priceSource;
  const maximumFillQuoteAgeMs = config.quoteFreshness?.maximumQuoteAgeMs ?? null;
  const corporateActions = [...(config.corporateActions ?? [])].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0,
  );
  const dividends = [...(config.dividends ?? [])].sort((a, b) =>
    a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0,
  );
  const replayable =
    rules.every((r) => !('build' in r) && typeof r.when !== 'function') &&
    exit.when === undefined &&
    roll?.when?.when === undefined;

  const snapshots = [...config.chains];
  snapshots.forEach((s, i) => requireSnapshot(s, i, FN));
  const ordered = snapshots
    .map((snap, i) => ({ snap, asOfMs: snapshotAsOf(snap, FN), i }))
    .sort((a, b) => a.asOfMs - b.asOfMs || a.i - b.i);
  const runId = contentHash({
    ...identityOf(config, rules),
    // Identity is order-invariant where the engine is: a snapshot's quotes are matched by contract,
    // so two requests that differ only in quote order are the same run (FC8 ordering invariance).
    chains: contentHash(
      ordered.map(({ snap }) => ({
        ...snap,
        quotes: [...snap.quotes].sort((a, b) =>
          quoteIdentityKey(a) < quoteIdentityKey(b)
            ? -1
            : quoteIdentityKey(a) > quoteIdentityKey(b)
              ? 1
              : 0,
        ),
      })),
    ),
  });
  const sourceId = `backtest:options:${runId}`;

  // ---- state ----------------------------------------------------------------------------------------
  const book: OpenTrade[] = [];
  let nextTradeId = 1;
  let cash = initialCapital;
  let hedgeShares = 0;
  let hedgeUnderlying: string | null = null;
  let sizingMode: 'fixed-quantity' | 'margin-aware' = 'fixed-quantity';
  const trades: OptionsTrade[] = [];
  const settlements: OptionSettlement[] = [];
  /** Every fill the book placed, in booking order — the same NormalizedFills the ledger folded. */
  const fills: NormalizedFill[] = [];
  const limitRejections: LimitRejection[] = [];
  const fillRejections: FillRejection[] = [];
  const surface: SurfaceRow[] = [];
  const warnings: QuantWarning[] = [];
  let earlyAssignmentCount = 0;
  let corporateActionsApplied = 0;
  const equityCurve: number[] = [initialCapital];
  const timestamps: EpochMs[] = [];

  // ---- the ledger -----------------------------------------------------------------------------------
  const events: PortfolioEventEnvelope[] = [];
  let state: PortfolioState | undefined;
  let eventSequence = 0;
  /**
   * The instant the ledger records this snapshot's events at. A snapshot's events fold in order, so
   * once an expiry settlement moves the clock to the contract's expiry instant (16:00 ET on a
   * date-only snapshot), every later event of the same snapshot carries that instant too.
   */
  let eventClock = 0;
  const stamp = (asOfMs: EpochMs): EpochMs => {
    if (asOfMs > eventClock) eventClock = asOfMs;
    return eventClock;
  };
  const fold = (batch: PortfolioEventEnvelope[]): void => {
    if (batch.length === 0) return;
    state =
      state === undefined
        ? applyPortfolioEvents({ portfolio: { baseCurrency }, events: batch })
        : applyPortfolioEvents({ previousState: state, events: batch });
    events.push(...batch);
  };
  const envelope = (
    asOfMs: EpochMs,
    event: PortfolioEventEnvelope['event'],
    correlationId?: string,
  ): PortfolioEventEnvelope => {
    eventSequence += 1;
    return {
      ...((): Record<string, never> => {
        void stamp(asOfMs);
        return {} as Record<string, never>;
      })(),
      eventId: `${runId}:e${eventSequence}`,
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      eventType: event.eventType,
      sourceId,
      accountId: ACCOUNT_ID,
      effectiveTimestampMs: eventClock,
      recordedTimestampMs: eventClock,
      ...(correlationId !== undefined ? { correlationId } : {}),
      event,
      provenance: {},
    };
  };
  const bookFill = (input: {
    asOfMs: EpochMs;
    instrumentId: string;
    side: OrderSide;
    quantity: number;
    pricePerUnit: number;
    contractMultiplier: number;
    contract?: NormalizedFill['contract'];
    costs: CostPieces;
    orderId: string;
  }): void => {
    if (input.quantity <= 0) return;
    eventSequence += 1;
    const fill: NormalizedFill = {
      fillId: `${runId}:f${eventSequence}`,
      accountId: ACCOUNT_ID,
      instrumentId: input.instrumentId,
      side: input.side,
      quantity: input.quantity,
      pricePerUnit: input.pricePerUnit,
      currency: baseCurrency,
      filledTimestampMs: stamp(input.asOfMs),
      contractMultiplier: input.contractMultiplier,
      settlementStyle: 'cash-on-trade',
      ...(input.contract !== undefined ? { contract: input.contract } : {}),
      costs: {
        ...(input.costs.commission > 0 ? { commission: input.costs.commission } : {}),
        ...(input.costs.slippageAdjustment > 0
          ? { slippageAdjustment: input.costs.slippageAdjustment }
          : {}),
      },
      orderId: input.orderId,
    };
    fills.push(fill);
    fold(portfolioEventsFromFill({ fill, sourceId, recordedTimestampMs: fill.filledTimestampMs }));
  };
  const optionTerms = (
    underlying: string,
    leg: Leg,
    expiry: string | undefined,
  ): NormalizedFill['contract'] =>
    leg.kind === 'stock' || expiry === undefined || expiry === ''
      ? undefined
      : {
          kind: 'option',
          underlyingInstrumentId: underlying,
          type: leg.kind,
          strikePricePerUnit: leg.strike,
          expiryTimestampMs: optionExpiryToMs(expiry),
        };

  if (ordered.length > 0) {
    fold([
      envelope(ordered[0]!.asOfMs, {
        eventType: 'cash.deposit',
        amount: initialCapital,
        currency: baseCurrency,
      }),
    ]);
  }

  // ---- the implied-volatility enrichment (unchanged from P1) ---------------------------------------
  const impliedVolatilityCache = new Map<ChainSnapshot, ChainSnapshot>();
  const enrichedQuotes = new WeakSet<OptionQuote>();
  const enrichSnapshot = (snap: ChainSnapshot, asOfMs: EpochMs): ChainSnapshot => {
    const hit = impliedVolatilityCache.get(snap);
    if (hit) return hit;
    const hasImpliedVolatility = snap.quotes.some(
      (q) => typeof q.impliedVolatility === 'number' && q.impliedVolatility > 0,
    );
    if (hasImpliedVolatility) {
      impliedVolatilityCache.set(snap, snap);
      return snap;
    }
    const quotes = snap.quotes.map((q) => {
      if (typeof q.impliedVolatility === 'number' && q.impliedVolatility > 0) return q;
      const price = selectQuotePrice(q, priceSource);
      if (price === undefined || !Number.isFinite(price)) return q;
      const t = yearFraction(asOfMs, optionExpiryToMs(q.contract.expiry), 'ACT/365F');
      if (!(t > 0)) return q;
      const impliedVolatility = blackScholesImpliedVolatility({
        type: q.contract.type,
        price,
        spot: snap.underlyingPrice,
        strike: q.contract.strike,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        dividendYield,
      });
      if (!(impliedVolatility.converged && impliedVolatility.value > 0)) return q;
      const enriched = { ...q, impliedVolatility: impliedVolatility.value };
      enrichedQuotes.add(enriched);
      return enriched;
    });
    const enriched: ChainSnapshot = { ...snap, quotes };
    impliedVolatilityCache.set(snap, enriched);
    return enriched;
  };

  const atmVolatility = (snap: ChainSnapshot): number | undefined => {
    let best: number | undefined;
    let bestDist = Infinity;
    for (const q of snap.quotes) {
      if (q.impliedVolatility === undefined) continue;
      const dist = Math.abs(q.contract.strike - snap.underlyingPrice);
      if (dist < bestDist) {
        bestDist = dist;
        best = q.impliedVolatility;
      }
    }
    return best;
  };

  // ---- Preview P1: the current-quote mark (per trade, unchanged law) --------------------------------
  const quoteIndexCache = new Map<ChainSnapshot, Map<string, OptionQuote[]>>();
  const quoteKey = (type: string, strike: number, expiry: string): string =>
    `${type}:${strike}:${expiry}`;
  const quoteIndex = (snap: ChainSnapshot): Map<string, OptionQuote[]> => {
    const hit = quoteIndexCache.get(snap);
    if (hit) return hit;
    const index = new Map<string, OptionQuote[]>();
    for (const q of snap.quotes) {
      const key = quoteKey(q.contract.type, q.contract.strike, q.contract.expiry);
      const list = index.get(key);
      if (list) list.push(q);
      else index.set(key, [q]);
    }
    quoteIndexCache.set(snap, index);
    return index;
  };
  const positionExpiryOf = (position: Position): string | undefined => {
    const expiries = new Set(position.legs.map((l) => l.expiry).filter((e) => e !== undefined));
    return expiries.size === 1 ? [...expiries][0] : undefined;
  };
  const currentLegMark = (
    leg: Leg,
    expiry: string | undefined,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
  ): LegMark => {
    if (leg.kind === 'stock' || expiry === undefined) return { intrinsic: true };
    if (daysToExpiry(asOfMs, expiry) <= 0) return { intrinsic: true };
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    if (!(t > 0)) return { intrinsic: true };
    const matches = quoteIndex(snap).get(quoteKey(leg.kind, leg.strike, expiry)) ?? [];
    if (matches.length === 0) return { cause: 'missing' };
    if (matches.length > 1) return { cause: 'ambiguous' };
    const q = matches[0]!;
    if (
      marking.maximumQuoteAgeMs !== null &&
      typeof q.timestampMs === 'number' &&
      asOfMs - q.timestampMs > marking.maximumQuoteAgeMs
    ) {
      return { cause: 'stale' };
    }
    if (
      typeof q.impliedVolatility === 'number' &&
      Number.isFinite(q.impliedVolatility) &&
      q.impliedVolatility > 0
    ) {
      return {
        volatility: q.impliedVolatility,
        source: enrichedQuotes.has(q) ? 'implied-from-price' : 'current-quote',
      };
    }
    const price = selectQuotePrice(q, priceSource);
    if (price === undefined || !Number.isFinite(price)) return { cause: 'unpriceable' };
    const implied = blackScholesImpliedVolatility({
      type: leg.kind,
      price,
      spot: snap.underlyingPrice,
      strike: leg.strike,
      timeToExpiryYears: t,
      riskFreeRate: rate,
      dividendYield,
    });
    return implied.converged && implied.value > 0
      ? { volatility: implied.value, source: 'implied-from-price' }
      : { cause: 'unpriceable' };
  };
  /** This snapshot's mark sources across every trade (the surface row's evidence). */
  let snapshotMarkSources: TradeMarkCounts = {
    snapshots: 0,
    currentQuote: 0,
    impliedFromPrice: 0,
    entryVolatility: 0,
    carried: 0,
  };
  const snapshotLegVolatilities = (
    t: OpenTrade,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
  ): (number | undefined)[] | null => {
    if (marking.volatility === 'entry') return null;
    if (t.markCache !== null && t.markCache.snap === snap) return t.markCache.legVolatilities;
    const positionExpiry = positionExpiryOf(t.position);
    const legVolatilities: (number | undefined)[] = [];
    t.marks.snapshots += 1;
    snapshotMarkSources.snapshots += 1;
    t.position.legs.forEach((leg, index) => {
      const live = t.live[index]!;
      const resolved = currentLegMark(leg, leg.expiry ?? positionExpiry, snap, asOfMs);
      if ('intrinsic' in resolved) {
        legVolatilities.push(undefined);
        return;
      }
      if ('volatility' in resolved) {
        legVolatilities.push(resolved.volatility);
        live.lastVolatility = resolved.volatility;
        if (resolved.source === 'current-quote') {
          t.marks.currentQuote += 1;
          snapshotMarkSources.currentQuote += 1;
        } else {
          t.marks.impliedFromPrice += 1;
          snapshotMarkSources.impliedFromPrice += 1;
        }
        return;
      }
      const fallback =
        marking.missingMark === 'entry-volatility'
          ? live.entryVolatility
          : marking.missingMark === 'carry-last-volatility'
            ? live.lastVolatility
            : undefined;
      if (marking.missingMark === 'refuse' || fallback === undefined) {
        throw new InputError(
          `${FN}: leg ${live.originalIndex} (${leg.kind} ${leg.strike} ${leg.expiry ?? positionExpiry}) has no usable mark at snapshot ${asOfMs}: ${MISSING_MARK_TEACHING[resolved.cause]}${marking.missingMark === 'refuse' ? '' : ` — and the '${marking.missingMark}' fallback has no volatility to fall back to for this leg`}. Supply the contract's current quote, choose a named fallback (marking.missingMark: 'entry-volatility' | 'carry-last-volatility'), or mark at entry volatility explicitly (marking.volatility: 'entry').`,
          {
            code: ErrorCode.BacktestMarkUnavailable,
            context: {
              function: FN,
              leg: live.originalIndex,
              contract: {
                type: leg.kind,
                strike: leg.strike,
                expiry: leg.expiry ?? positionExpiry,
              },
              asOf: asOfMs,
              cause: resolved.cause,
              missingMark: marking.missingMark,
            },
          },
        );
      }
      legVolatilities.push(fallback);
      live.lastVolatility = fallback;
      if (marking.missingMark === 'entry-volatility') {
        t.marks.entryVolatility += 1;
        snapshotMarkSources.entryVolatility += 1;
      } else {
        t.marks.carried += 1;
        snapshotMarkSources.carried += 1;
      }
      t.fallbacks.set(resolved.cause, (t.fallbacks.get(resolved.cause) ?? 0) + 1);
    });
    t.markCache = { snap, legVolatilities };
    return legVolatilities;
  };

  const mark = (
    position: Position,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    legVolatilities?: readonly (number | undefined)[] | null,
  ) => {
    const input = { spot: snap.underlyingPrice, asOf: asOfMs, riskFreeRate: rate, dividendYield };
    const volatility = atmVolatility(snap);
    if (legVolatilities !== undefined && legVolatilities !== null) {
      return volatility === undefined
        ? position.value({ ...input, legVolatilities })
        : position.value({ ...input, legVolatilities, volatility });
    }
    return volatility === undefined
      ? position.value(input)
      : position.value({ ...input, volatility });
  };
  const markTrade = (t: OpenTrade, snap: ChainSnapshot, asOfMs: EpochMs, markAsOf = asOfMs) =>
    mark(t.position, snap, markAsOf, snapshotLegVolatilities(t, snap, asOfMs));

  /** Current dollar value of one open trade's live legs (entry basis + running P&L of the live legs). */
  const tradeValue = (t: OpenTrade, snap: ChainSnapshot, asOfMs: EpochMs): number =>
    t.position.legs.length === 0
      ? 0
      : markTrade(t, snap, asOfMs).perLeg.reduce((sum, p) => sum + p.value, 0);
  const openOptionValue = (snap: ChainSnapshot, asOfMs: EpochMs): number =>
    book.reduce((sum, t) => sum + tradeValue(t, snap, asOfMs), 0);

  const skip = (asOfMs: EpochMs, ruleId: string, reason: string): void => {
    warnings.push({
      code: WarningCode.BacktestEntrySkipped,
      message: `No entry for ${ruleId} at ${asOfMs}: ${reason}.`,
      severity: 'info',
    });
  };

  // ---- the underlying hedge (book-level) -------------------------------------------------------------
  const tradeUnderlying = (hedgeTrade: {
    deltaShares: number;
    spot: number;
    asOfMs: EpochMs;
    underlying: string;
  }): void => {
    const { deltaShares, spot, asOfMs, underlying } = hedgeTrade;
    if (deltaShares === 0) return;
    const side: OrderSide = sideOf(deltaShares);
    const shares = Math.abs(deltaShares);
    const pieces: CostPieces = {
      commission: hedgeCommission.commission({ quantity: shares, price: spot }),
      slippageAdjustment:
        Math.abs(hedgeSlippage.fill({ referencePrice: spot, side, quantity: shares }) - spot) *
        shares,
    };
    cash -= deltaShares * spot + pieces.commission + pieces.slippageAdjustment;
    hedgeShares += deltaShares;
    hedgeUnderlying = underlying;
    bookFill({
      asOfMs,
      instrumentId: underlying,
      side,
      quantity: shares,
      pricePerUnit: spot,
      contractMultiplier: 1,
      costs: pieces,
      orderId: `${runId}:hedge:${asOfMs}`,
    });
  };
  const rehedge = (snap: ChainSnapshot, asOfMs: EpochMs): void => {
    if (!hedge) return;
    if (book.length === 0) {
      if (hedgeShares !== 0 && hedgeUnderlying !== null)
        tradeUnderlying({
          deltaShares: -hedgeShares,
          spot: snap.underlyingPrice,
          asOfMs,
          underlying: hedgeUnderlying,
        });
      return;
    }
    let optionDelta = 0;
    for (const t of book)
      optionDelta += t.position.legs.length === 0 ? 0 : markTrade(t, snap, asOfMs).greeks.delta;
    if (Math.abs(optionDelta + hedgeShares) <= hedge.deltaBand) return;
    tradeUnderlying({
      deltaShares: -optionDelta - hedgeShares,
      spot: snap.underlyingPrice,
      asOfMs,
      underlying: book[0]!.underlying,
    });
  };

  // ---- settlement of individual legs (expiry, early assignment) -------------------------------------
  /** Settle the given live legs at intrinsic (cash) and rebuild the trade's position from the rest. */
  const settleLegs = (
    t: OpenTrade,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    which: (leg: Leg, index: number) => boolean,
    early: { reason: 'dividend' | 'deep-itm' } | null,
  ): { settled: number; assigned: boolean } => {
    const S = snap.underlyingPrice;
    const remaining: TradeLeg[] = [];
    let settled = 0;
    let assigned = false;
    const mult = t.position.multiplier;
    t.position.legs.forEach((leg, index) => {
      const live = t.live[index]!;
      if (leg.kind === 'stock' || leg.expiry === undefined || !which(leg, index)) {
        remaining.push(live);
        return;
      }
      const intrinsic = intrinsicOf(leg.kind, S, leg.strike);
      const action = intrinsic <= 0 ? 'expired' : leg.quantity > 0 ? 'exercised' : 'assigned';
      const cashFlow = leg.quantity * mult * intrinsic;
      cash += cashFlow;
      t.settledPnl += leg.quantity * mult * (intrinsic - leg.premium);
      const settlement: OptionSettlement = {
        symbol: live.instrumentId,
        underlying: t.underlying,
        timestampMs: asOfMs,
        type: leg.kind,
        strike: leg.strike,
        multiplier: mult,
        contracts: leg.quantity,
        underlierPrice: S,
        intrinsic,
        action,
        settlement: 'cash',
        cashFlow,
        shares: 0,
        ...(early !== null ? { early: true, reason: early.reason } : {}),
      };
      settlements.push(settlement);
      t.legSettlements.push({ legIndex: live.originalIndex, settlement });
      if (action === 'assigned') {
        assigned = true;
        warnings.push({
          code: WarningCode.BacktestAssignment,
          message:
            early === null
              ? `A short ${leg.kind} at ${leg.strike} was ITM at expiry and assigned.`
              : `A short ${leg.kind} at ${leg.strike} was assigned early (${early.reason}) at ${asOfMs}.`,
          severity: 'info',
        });
      }
      const quantity = Math.abs(leg.quantity);
      if (early === null) stamp(optionExpiryToMs(leg.expiry));
      const event: PortfolioEventEnvelope['event'] =
        action === 'expired'
          ? { eventType: 'derivative.expiration', instrumentId: live.instrumentId, quantity }
          : action === 'exercised'
            ? {
                eventType: 'derivative.exercise',
                instrumentId: live.instrumentId,
                quantity,
                settlement: { kind: 'cash', settlementPricePerUnit: S },
                premiumTreatment: 'realize',
              }
            : {
                eventType: 'derivative.assignment',
                instrumentId: live.instrumentId,
                quantity,
                settlement: { kind: 'cash', settlementPricePerUnit: S },
                premiumTreatment: 'realize',
              };
      fold([envelope(asOfMs, event, `${runId}:t${t.tradeId}`)]);
      settled += 1;
    });
    if (settled > 0) {
      t.live = remaining;
      t.position = new Position(
        remaining.map((r) => ({ ...r.leg })),
        {
          multiplier: mult,
          ...(positionExpiryOf(t.position) !== undefined
            ? { expiry: positionExpiryOf(t.position)! }
            : {}),
        },
      );
      t.markCache = null;
    }
    return { settled, assigned };
  };

  const discloseFallbacks = (t: OpenTrade): void => {
    for (const [cause, count] of [...t.fallbacks.entries()].sort()) {
      warnings.push({
        code: WarningCode.BacktestMarkFallback,
        message: `${FN}: the trade entered at ${t.entryAsOf} marked ${count} leg-snapshot${count === 1 ? '' : 's'} by the '${marking.missingMark}' fallback because ${MISSING_MARK_TEACHING[cause]} (cause '${cause}') — its P&L over those marks is not quote-driven.`,
        severity: 'warn',
        context: {
          entryAsOf: t.entryAsOf,
          cause,
          legSnapshots: count,
          missingMark: marking.missingMark,
        },
      });
    }
  };

  const tradeRow = (input: {
    t: OpenTrade;
    /** The position and live legs the row describes — captured BEFORE a settlement removed legs. */
    position: Position;
    live: readonly TradeLeg[];
    snap: ChainSnapshot;
    exitAsOf: EpochMs | null;
    reason: ExitReason;
    exitCosts: number;
    m: ReturnType<typeof markTrade> | null;
    markAsOf: EpochMs;
    grossPnl: number;
  }): OptionsTrade => {
    const { t, position, live, snap, exitAsOf, reason, exitCosts, m, markAsOf, grossPnl } = input;
    const perLeg = m === null ? [] : m.perLeg;
    const exitVolatilities: (number | null)[] = t.originalLegs.map(() => null);
    const attribution: LegAttribution[] = t.originalLegs.map((leg) => ({ leg, realizedPnl: 0 }));
    for (const { legIndex, settlement } of t.legSettlements) {
      const leg = t.originalLegs[legIndex]!;
      attribution[legIndex] = {
        leg,
        realizedPnl:
          leg.quantity *
          settlement.multiplier *
          (settlement.intrinsic - (leg.kind === 'stock' ? leg.price : leg.premium)),
      };
    }
    live.forEach((l, index) => {
      const valuation = perLeg[index];
      if (valuation === undefined) return;
      attribution[l.originalIndex] = { leg: l.leg, realizedPnl: valuation.pnl };
      exitVolatilities[l.originalIndex] =
        l.leg.kind === 'stock' || valuation.greeks.vega === 0 ? null : (l.lastVolatility ?? null);
    });
    return {
      structure: t.structure,
      entryAsOf: t.entryAsOf,
      exitAsOf,
      expiry: positionExpiriesOfLegs(t.originalLegs)[0] ?? '',
      contracts: t.contracts,
      entryPremium: t.entryPremium,
      realizedPnl: grossPnl - t.entryCosts - exitCosts,
      costs: t.entryCosts + exitCosts,
      exitReason: reason,
      perLeg: attribution,
      legs: t.originalLegs,
      pnlExplain: tradePnlExplain({
        position,
        entry: {
          asOf: t.entryAsOf,
          spot: t.entrySpot,
          volatility: t.entryVolatility,
          ...(marking.volatility === 'current-quote'
            ? { legVolatilities: live.map((l) => l.entryVolatility) }
            : {}),
        },
        exit: {
          asOf: markAsOf,
          spot: snap.underlyingPrice,
          volatility: atmVolatility(snap),
          ...(marking.volatility === 'current-quote' && m !== null
            ? {
                legVolatilities: live.map((l, index) =>
                  l.leg.kind === 'stock' || perLeg[index]?.greeks.vega === 0
                    ? undefined
                    : l.lastVolatility,
                ),
              }
            : {}),
        },
        riskFreeRate: rate,
        dividendYield,
        grossPnl,
      }),
      marks: { ...t.marks },
      exitVolatilities,
      tradeId: t.tradeId,
      ruleId: t.ruleId,
      underlying: t.underlying,
      legInstrumentIds: [...t.originalInstrumentIds],
      lineage: [...t.lineage],
      partial: t.partial,
      unfilledLegs: [...t.unfilledLegs],
      legSettlements: [...t.legSettlements],
    };
  };
  const positionExpiriesOfLegs = (legs: readonly Leg[]): string[] => {
    const set = new Set<string>();
    for (const l of legs) if (l.expiry !== undefined) set.add(l.expiry);
    return [...set];
  };

  const removeFromBook = (t: OpenTrade): void => {
    const index = book.indexOf(t);
    if (index >= 0) book.splice(index, 1);
  };

  /** Close a trade: settle any expired legs, sell the live legs at their marks, record the row. */
  /**
   * Close a trade. A settlement marks the WHOLE position at the settlement instant first (expired
   * legs at intrinsic — the explain and the attribution see every leg), settles the expired legs
   * (cash and ledger events), then closes whatever remains at that same mark.
   */
  const closeTrade = (
    t: OpenTrade,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    reason: ExitReason,
    isSettlement: boolean,
  ): void => {
    const position = t.position;
    const live = [...t.live];
    let m: ReturnType<typeof markTrade> | null = null;
    let exitCosts = 0;
    let markAsOf = asOfMs;
    let grossPnl = t.settledPnl;
    if (position.legs.length > 0) {
      markAsOf = isSettlement ? settlementInstant(position, asOfMs) : asOfMs;
      m = markTrade(t, snap, asOfMs, markAsOf);
      grossPnl = m.pnl + t.settledPnl;
      const settledBefore = t.legSettlements.length;
      if (isSettlement) {
        settleLegs(
          t,
          snap,
          asOfMs,
          (leg) => leg.expiry !== undefined && daysToExpiry(asOfMs, leg.expiry) <= 0,
          null,
        );
      }
      const settledNow = new Set(t.legSettlements.slice(settledBefore).map((x) => x.legIndex));
      const mult = position.multiplier;
      const pieces: CostPieces[] = [];
      let closingValue = 0;
      m.perLeg.forEach((p, index) => {
        const l = live[index]!;
        if (settledNow.has(l.originalIndex)) return;
        closingValue += p.value;
        const units = Math.abs(p.leg.quantity);
        if (units === 0) return;
        const side: OrderSide = sideOf(-p.leg.quantity); // closing: the opposite of the held sign
        if (p.leg.kind === 'stock') {
          const shares = units;
          bookFill({
            asOfMs,
            instrumentId: l.instrumentId,
            side,
            quantity: shares,
            pricePerUnit: Math.abs(p.value) / shares,
            contractMultiplier: 1,
            costs: { commission: 0, slippageAdjustment: 0 },
            orderId: `${runId}:t${t.tradeId}:close`,
          });
          return;
        }
        const perContractPrice = Math.abs(p.value / p.leg.quantity);
        const piece = isSettlement
          ? { commission: 0, slippageAdjustment: 0 }
          : legCost(units, perContractPrice, side, commission, slippage);
        pieces.push(piece);
        bookFill({
          asOfMs,
          instrumentId: l.instrumentId,
          side,
          quantity: units,
          pricePerUnit: perContractPrice / mult,
          contractMultiplier: mult,
          contract: optionTerms(t.underlying, p.leg, p.leg.expiry ?? positionExpiryOf(position)),
          costs: piece,
          orderId: `${runId}:t${t.tradeId}:close`,
        });
      });
      exitCosts = totalCost(pieces);
      cash += closingValue - exitCosts;
    }
    discloseFallbacks(t);
    trades.push(
      tradeRow({
        t,
        position,
        live,
        snap,
        exitAsOf: asOfMs,
        reason,
        exitCosts,
        m,
        markAsOf,
        grossPnl,
      }),
    );
    removeFromBook(t);
  };

  // ---- the pre-trade limits, on the post-trade book ---------------------------------------------------
  const limitCheck = (
    candidate: OpenTrade,
    candidateMark: ReturnType<typeof markTrade>,
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    equityNow: number,
  ): LimitRejection | null => {
    const rejection = (
      limit: keyof PortfolioLimits,
      value: number,
      bound: number,
    ): LimitRejection => ({
      asOf: asOfMs,
      ruleId: candidate.ruleId,
      structure: candidate.structure,
      limit,
      value,
      bound,
      code: WarningCode.BacktestLimitRejected,
    });
    const spot = snap.underlyingPrice;
    const all = [...book, candidate];
    const marks = all.map((t) => (t === candidate ? candidateMark : markTrade(t, snap, asOfMs)));
    if (limits.maximumMarginFraction !== undefined) {
      const margin = all.reduce((sum, t) => sum + optionMargin(t.position, spot), 0);
      const bound = limits.maximumMarginFraction * equityNow;
      if (margin > bound) return rejection('maximumMarginFraction', margin, bound);
    }
    const sameUnderlying = all
      .map((t, i) => [t, marks[i]!] as const)
      .filter(([t]) => t.underlying === candidate.underlying);
    if (limits.maximumNetDelta !== undefined) {
      const delta =
        sameUnderlying.reduce((sum, [, mk]) => sum + mk.greeks.delta, 0) +
        (hedgeUnderlying === candidate.underlying ? hedgeShares : 0);
      if (Math.abs(delta) > limits.maximumNetDelta)
        return rejection('maximumNetDelta', Math.abs(delta), limits.maximumNetDelta);
    }
    if (limits.maximumNetVega !== undefined) {
      const vega = sameUnderlying.reduce((sum, [, mk]) => sum + mk.greeks.vega, 0);
      if (Math.abs(vega) > limits.maximumNetVega)
        return rejection('maximumNetVega', Math.abs(vega), limits.maximumNetVega);
    }
    if (limits.maximumConcentration !== undefined) {
      const atRisk = sameUnderlying.reduce((sum, [t]) => sum + Math.abs(t.entryPremium), 0);
      const bound = limits.maximumConcentration * equityNow;
      if (atRisk > bound) return rejection('maximumConcentration', atRisk, bound);
    }
    if (limits.scenarioLoss !== undefined) {
      const aggregate = aggregateGreeks(
        marks.map((mk, i) => ({
          id: `t${all[i]!.tradeId}`,
          quantity: 1,
          greeks: {
            value: mk.perLeg.reduce((s, p) => s + p.value, 0),
            spot,
            delta: mk.greeks.delta,
            gamma: mk.greeks.gamma,
            vega: mk.greeks.vega,
            theta: mk.greeks.theta,
            rho: mk.greeks.rho,
          },
        })),
      );
      const greeks = aggregate.value;
      const grid = scenarioGrid({
        greeks: {
          value: greeks.value,
          spot,
          delta: greeks.delta,
          gamma: greeks.gamma,
          vega: greeks.vega,
          theta: greeks.theta,
          rho: greeks.rho,
        },
        spotShocks: limits.scenarioLoss.spotShocks.map((value) => ({
          factor: 'spot',
          kind: 'percent',
          value,
        })),
        volatilityShocks: limits.scenarioLoss.volatilityShocks.map((value) => ({
          factor: 'volatility',
          kind: 'absolute',
          value,
        })),
      });
      let worst = 0;
      for (const row of grid.pnl) for (const pnl of row) if (pnl < worst) worst = pnl;
      const bound = limits.scenarioLoss.maximumLossFraction * equityNow;
      if (-worst > bound) return rejection('scenarioLoss', -worst, bound);
    }
    return null;
  };

  // ---- the fill policy -------------------------------------------------------------------------------
  const usability = (
    quote: OptionQuote | undefined,
    asOfMs: EpochMs,
  ): UnfilledLeg['cause'] | null => {
    if (quote === undefined) return 'missing';
    if (
      maximumFillQuoteAgeMs !== null &&
      typeof quote.timestampMs === 'number' &&
      asOfMs - quote.timestampMs > maximumFillQuoteAgeMs
    )
      return 'stale';
    const price = selectQuotePrice(quote, fillPrice);
    if (price === undefined || !Number.isFinite(price) || price < 0) return 'unpriceable';
    return null;
  };

  // ---- entry -----------------------------------------------------------------------------------------
  const openTradeViews = (snap: ChainSnapshot, asOfMs: EpochMs): OpenTradeView[] =>
    book.map((t) => ({
      tradeId: t.tradeId,
      ruleId: t.ruleId,
      structure: t.structure,
      underlying: t.underlying,
      entryAsOf: t.entryAsOf,
      entryPremium: t.entryPremium,
      markToMarket: t.position.legs.length === 0 ? 0 : markTrade(t, snap, asOfMs).pnl,
      legs: t.originalLegs,
    }));
  const underlyingOf = (snap: ChainSnapshot, quotes: readonly (OptionQuote | null)[]): string =>
    quotes.find((q) => q !== null)?.contract.underlying ??
    snap.quotes[0]?.contract.underlying ??
    'UNDERLYING';

  const tryEnter = (attempt: {
    ruleIndex: number;
    snap: ChainSnapshot;
    asOfMs: EpochMs;
    equityNow: number;
  }): void => {
    const { ruleIndex, snap, asOfMs, equityNow } = attempt;
    const rule = rules[ruleIndex]!;
    const ruleId = ruleIds[ruleIndex]!;
    if (book.length >= maximumOpenPositions) return;
    const flat = !book.some((t) => t.ruleIndex === ruleIndex);
    const context: EntryContext = {
      snapshot: snap,
      asOf: asOfMs,
      cash,
      equity: equityNow,
      flat,
      openTrades: openTradeViews(snap, asOfMs),
    };
    const gate = rule.when ?? 'flat';
    const gateOpen = gate === 'flat' ? flat : gate === 'always' ? true : gate(context);
    if (!gateOpen) return;

    const isBuild = 'build' in rule;
    const buildFn = (): Position | null => (isBuild ? rule.build(context) : null);
    let quantity = 1;
    if (!isBuild && rule.sizing && 'quantity' in rule.sizing) {
      quantity = rule.sizing.quantity;
    } else if (!isBuild && rule.sizing && 'maxMarginFraction' in rule.sizing) {
      sizingMode = 'margin-aware';
      const probe = buildEntryPosition(rule, snap, asOfMs, 1, buildFn);
      if ('skip' in probe) return skip(asOfMs, ruleId, probe.skip);
      const perLot = optionMargin(probe.position, snap.underlyingPrice);
      const budget = Math.max(0, rule.sizing.maxMarginFraction * equityNow);
      quantity = perLot > 0 ? Math.floor(budget / perLot) : 0;
      if (quantity < 1) return skip(asOfMs, ruleId, 'margin budget affords < 1 contract');
    }
    const built = buildEntryPosition(rule, snap, asOfMs, quantity, buildFn);
    if ('skip' in built) return skip(asOfMs, ruleId, built.skip);
    let position = built.position;
    const structure = position.constructedAs ?? ('structure' in rule ? rule.structure : 'custom');
    const underlying = underlyingOf(snap, built.quotes);
    if (
      maximumPerUnderlying !== null &&
      book.filter((t) => t.underlying === underlying).length >= maximumPerUnderlying
    )
      return;

    // The fill policy: every leg's quote must be usable (combo), or the sequence stops (legged).
    const unfilled: UnfilledLeg[] = [];
    if (!isBuild) {
      const keep: boolean[] = position.legs.map(() => true);
      let stopped = false;
      let optionLegs = 0;
      position.legs.forEach((leg, index) => {
        if (leg.kind === 'stock') return;
        optionLegs += 1;
        const cause = stopped ? 'missing' : usability(built.quotes[index] ?? undefined, asOfMs);
        if (cause === null && !stopped) return;
        if (fillMode === 'legged') stopped = true;
        unfilled.push({ leg, cause: cause ?? 'missing' });
        keep[index] = false;
      });
      if (unfilled.length > 0) {
        const kept = position.legs.filter((_, index) => keep[index]);
        if (
          fillMode === 'combo' ||
          partialFill === 'reject' ||
          kept.every((l) => l.kind === 'stock')
        ) {
          fillRejections.push({
            asOf: asOfMs,
            ruleId,
            structure,
            mode: fillMode,
            unfilledLegs: unfilled,
            code: WarningCode.BacktestComboLegUnfilled,
          });
          warnings.push({
            code: WarningCode.BacktestComboLegUnfilled,
            message: `${FN}: ${ruleId} at ${asOfMs}: ${unfilled.length} of ${optionLegs} legs could not fill (${unfilled.map((u) => `${u.leg.kind} ${u.leg.strike}: ${u.cause}`).join('; ')}) — the entry was rejected under fillPolicy.mode '${fillMode}'.`,
            severity: 'info',
          });
          return;
        }
        position = new Position(
          kept.map((l) => ({ ...l })),
          {
            multiplier: position.multiplier,
            ...(positionExpiryOf(position) !== undefined
              ? { expiry: positionExpiryOf(position)! }
              : {}),
          },
        );
      }
    }

    const positionExpiry = positionExpiryOf(position);
    const candidate: OpenTrade = {
      tradeId: nextTradeId,
      ruleId,
      ruleIndex,
      underlying,
      structure,
      position,
      live: position.legs.map((leg, index) => ({
        leg,
        originalIndex: index,
        instrumentId: legInstrumentId(underlying, leg, leg.expiry ?? positionExpiry),
        entryVolatility: leg.kind === 'stock' ? undefined : leg.impliedVolatility,
        lastVolatility: leg.kind === 'stock' ? undefined : leg.impliedVolatility,
      })),
      originalLegs: [...position.legs],
      originalInstrumentIds: position.legs.map((leg) =>
        legInstrumentId(underlying, leg, leg.expiry ?? positionExpiry),
      ),
      entryAsOf: asOfMs,
      entryPremium: 0,
      contracts: isBuild ? maxLotOf(position) : quantity,
      entryCosts: 0,
      entrySpot: snap.underlyingPrice,
      entryVolatility: atmVolatility(snap),
      markCache: null,
      marks: { snapshots: 0, currentQuote: 0, impliedFromPrice: 0, entryVolatility: 0, carried: 0 },
      fallbacks: new Map(),
      settledPnl: 0,
      legSettlements: [],
      lineage: [],
      partial: unfilled.length > 0,
      unfilledLegs: unfilled,
    };
    let entryMark: ReturnType<typeof markTrade>;
    try {
      entryMark = markTrade(candidate, snap, asOfMs);
      candidate.live.forEach((l, index) => {
        if (entryMark.perLeg[index]!.leg.kind !== 'stock') l.entryVolatility = l.lastVolatility;
      });
    } catch (err) {
      if (isQuantError(err)) {
        return skip(
          asOfMs,
          ruleId,
          isQuantError(err, ErrorCode.BacktestMarkUnavailable)
            ? `position not markable from the entry snapshot (${String((err.context as { cause?: unknown }).cause)})`
            : 'position not markable (no vol available)',
        );
      }
      throw err;
    }
    const entryPremium = position.netDebit();
    candidate.entryPremium = entryPremium;
    const rejected = limitCheck(candidate, entryMark, snap, asOfMs, equityNow);
    if (rejected !== null) {
      limitRejections.push(rejected);
      warnings.push({
        code: WarningCode.BacktestLimitRejected,
        message: `${FN}: ${ruleId} at ${asOfMs}: the post-trade book would carry ${rejected.limit} = ${rejected.value} against the bound ${rejected.bound} — the entry was rejected; nothing was scaled.`,
        severity: 'info',
      });
      return;
    }
    // Fills: one per option leg at the entry premium, with the ledger's cost rows.
    const mult = position.multiplier;
    const pieces: CostPieces[] = [];
    position.legs.forEach((leg, index) => {
      if (leg.kind === 'stock') {
        const shares = Math.abs(leg.quantity);
        const side: OrderSide = sideOf(leg.quantity);
        bookFill({
          asOfMs,
          instrumentId: underlying,
          side,
          quantity: shares,
          pricePerUnit: leg.price,
          contractMultiplier: 1,
          costs: { commission: 0, slippageAdjustment: 0 },
          orderId: `${runId}:t${candidate.tradeId}:open`,
        });
        return;
      }
      const contracts = Math.abs(leg.quantity);
      const side: OrderSide = sideOf(leg.quantity);
      const piece = legCost(contracts, perContract(leg.premium, mult), side, commission, slippage);
      pieces.push(piece);
      bookFill({
        asOfMs,
        instrumentId: candidate.live[index]!.instrumentId,
        side,
        quantity: contracts,
        pricePerUnit: leg.premium,
        contractMultiplier: mult,
        contract: optionTerms(underlying, leg, leg.expiry ?? positionExpiry),
        costs: piece,
        orderId: `${runId}:t${candidate.tradeId}:open`,
      });
    });
    const cost = totalCost(pieces);
    cash += -entryPremium - cost;
    candidate.entryCosts = cost;
    nextTradeId += 1;
    book.push(candidate);
  };

  // ---- corporate actions and dividends ---------------------------------------------------------------
  let nextActionIndex = 0;
  const applyCorporateActions = (asOfMs: EpochMs): void => {
    const date = dateOf(asOfMs);
    while (
      nextActionIndex < corporateActions.length &&
      corporateActions[nextActionIndex]!.effectiveDate <= date
    ) {
      const action = corporateActions[nextActionIndex]!;
      nextActionIndex += 1;
      const affected = book.filter((t) => t.underlying === action.symbol);
      if (action.type === 'dividend' || action.type === 'other') continue;
      if (affected.length === 0 && !(hedgeUnderlying === action.symbol && hedgeShares !== 0))
        continue;
      if (action.type === 'merger' || action.type === 'spinoff') {
        throw new InputError(
          `${FN}: a ${action.type} on ${action.symbol} effective ${action.effectiveDate} meets ${affected.length} open option trade${affected.length === 1 ? '' : 's'} — the deliverable of an open option leg cannot be adjusted for a ${action.type}; close the legs before the effective date or drop the action.`,
          {
            code: ErrorCode.BacktestUnsupportedCorporateAction,
            context: {
              function: FN,
              action: action.type,
              symbol: action.symbol,
              effectiveDate: action.effectiveDate,
            },
          },
        );
      }
      corporateActionsApplied += 1;
      const lineageId = `${runId}:ca${nextActionIndex}`;
      if (action.type === 'symbolChange') {
        const to = action.newSymbol!;
        for (const t of affected) {
          t.lineage.push({
            lineageId,
            action: action.type,
            effectiveDate: action.effectiveDate,
            asOf: asOfMs,
            previous: {
              underlying: t.underlying,
              strikes: t.position.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])),
              multiplier: t.position.multiplier,
            },
            adjusted: {
              underlying: to,
              strikes: t.position.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])),
              multiplier: t.position.multiplier,
            },
          });
          t.underlying = to;
        }
        if (hedgeUnderlying === action.symbol && hedgeShares !== 0) {
          fold([
            envelope(asOfMs, {
              eventType: 'corporate.symbol-change',
              fromInstrumentId: action.symbol,
              toInstrumentId: to,
            }),
          ]);
          hedgeUnderlying = to;
        }
        continue;
      }
      // split / reverseSplit: strike ÷ ratio, multiplier × ratio; quantity and exposure unchanged.
      const ratio = action.ratio!;
      for (const t of affected) {
        const previous = {
          underlying: t.underlying,
          strikes: t.position.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])),
          multiplier: t.position.multiplier,
        };
        const adjustedMultiplier = t.position.multiplier * ratio;
        const adjustedLegs = t.position.legs.map((l) =>
          l.kind === 'stock'
            ? { ...l }
            : { ...l, strike: l.strike / ratio, premium: l.premium / ratio },
        );
        t.position = new Position(adjustedLegs, {
          multiplier: adjustedMultiplier,
          ...(positionExpiryOf(t.position) !== undefined
            ? { expiry: positionExpiryOf(t.position)! }
            : {}),
        });
        t.live = t.live.map((l, i) => ({ ...l, leg: t.position.legs[i]! }));
        t.markCache = null;
        t.lineage.push({
          lineageId,
          action: action.type,
          effectiveDate: action.effectiveDate,
          asOf: asOfMs,
          previous,
          adjusted: {
            underlying: t.underlying,
            strikes: t.position.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])),
            multiplier: adjustedMultiplier,
          },
        });
        t.live.forEach((l) => {
          if (l.leg.kind === 'stock') return;
          fold([
            envelope(
              asOfMs,
              {
                eventType: 'derivative.multiplier-change',
                instrumentId: l.instrumentId,
                contractMultiplierAfter: adjustedMultiplier,
                strikePricePerUnitAfter: l.leg.strike,
                reason: `${action.type} ${ratio}:1 on ${action.symbol} (${lineageId})`,
              },
              lineageId,
            ),
          ]);
        });
      }
      if (hedgeUnderlying === action.symbol && hedgeShares !== 0) {
        const after = Math.round(ratio * 1_000_000);
        fold([
          envelope(asOfMs, {
            eventType: 'corporate.split',
            instrumentId: action.symbol,
            sharesAfterSplit: after,
            sharesBeforeSplit: 1_000_000,
          }),
        ]);
        hedgeShares *= ratio;
      }
    }
  };

  /** Dividend evidence: every open short call before an ex-date; early assignment under 'model'. */
  const dividendEvidence = (
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    nextAsOfMs: EpochMs | null,
  ): DividendRiskRow[] => {
    const rows: DividendRiskRow[] = [];
    if (dividends.length === 0) return rows;
    const date = dateOf(asOfMs);
    const nextDate = nextAsOfMs === null ? null : dateOf(nextAsOfMs);
    for (const dividend of dividends) {
      // the last snapshot strictly before the ex-date: date < exDate ≤ next snapshot's date (or none follows)
      if (!(date < dividend.exDate && (nextDate === null || nextDate >= dividend.exDate))) continue;
      for (const t of [...book]) {
        if (t.underlying !== dividend.underlying || t.position.legs.length === 0) continue;
        const m = markTrade(t, snap, asOfMs);
        const atRiskLegs: number[] = [];
        t.position.legs.forEach((leg, index) => {
          if (leg.kind !== 'call' || leg.quantity >= 0 || leg.expiry === undefined) return;
          if (leg.expiry < dividend.exDate) return;
          const perShare =
            Math.abs(m.perLeg[index]!.value) / (Math.abs(leg.quantity) * t.position.multiplier);
          const extrinsic = Math.max(
            0,
            perShare - intrinsicOf('call', snap.underlyingPrice, leg.strike),
          );
          const atRisk = dividend.amount > extrinsic;
          rows.push({
            tradeId: t.tradeId,
            legIndex: t.live[index]!.originalIndex,
            underlying: t.underlying,
            exDate: dividend.exDate,
            dividend: dividend.amount,
            extrinsic,
            atRisk,
          });
          if (atRisk) atRiskLegs.push(index);
        });
        if (assignment === 'model' && atRiskLegs.length > 0) {
          const { settled } = settleLegs(
            t,
            snap,
            asOfMs,
            (_leg, index) => atRiskLegs.includes(index),
            { reason: 'dividend' },
          );
          earlyAssignmentCount += settled;
          // an assigned structure whose only remaining legs are stock is closed at market
          if (t.position.legs.every((l) => l.kind === 'stock'))
            closeTrade(t, snap, asOfMs, 'assignment', false);
        }
      }
    }
    return rows;
  };

  /** Deep-ITM short puts under 'model': assigned when the extrinsic value is below the carry. */
  const deepInTheMoneyAssignment = (snap: ChainSnapshot, asOfMs: EpochMs): void => {
    if (assignment !== 'model') return;
    for (const t of [...book]) {
      if (t.position.legs.length === 0) continue;
      const m = markTrade(t, snap, asOfMs);
      const targets: number[] = [];
      t.position.legs.forEach((leg, index) => {
        if (leg.kind !== 'put' || leg.quantity >= 0 || leg.expiry === undefined) return;
        const intrinsic = intrinsicOf('put', snap.underlyingPrice, leg.strike);
        if (intrinsic <= 0) return;
        const years = Math.max(0, yearFraction(asOfMs, optionExpiryToMs(leg.expiry), 'ACT/365F'));
        const carry = leg.strike * (1 - Math.exp(-rate * years));
        const perShare =
          Math.abs(m.perLeg[index]!.value) / (Math.abs(leg.quantity) * t.position.multiplier);
        const extrinsic = Math.max(0, perShare - intrinsic);
        if (extrinsic < carry) targets.push(index);
      });
      if (targets.length > 0) {
        const { settled } = settleLegs(t, snap, asOfMs, (_leg, index) => targets.includes(index), {
          reason: 'deep-itm',
        });
        earlyAssignmentCount += settled;
        if (t.position.legs.every((l) => l.kind === 'stock'))
          closeTrade(t, snap, asOfMs, 'assignment', false);
      }
    }
  };

  // ---- the surface row --------------------------------------------------------------------------------
  const surfaceRow = (
    snap: ChainSnapshot,
    asOfMs: EpochMs,
    dividendRisk: DividendRiskRow[],
  ): SurfaceRow => {
    const atm: Record<string, number> = {};
    const nearest: Record<string, number> = {};
    for (const q of snap.quotes) {
      if (typeof q.impliedVolatility !== 'number' || !(q.impliedVolatility > 0)) continue;
      const dist = Math.abs(q.contract.strike - snap.underlyingPrice);
      if (nearest[q.contract.expiry] === undefined || dist < nearest[q.contract.expiry]!) {
        nearest[q.contract.expiry] = dist;
        atm[q.contract.expiry] = q.impliedVolatility;
      }
    }
    let skew25Delta: number | null = null;
    const expiries = Object.keys(atm).sort();
    const first = expiries[0];
    if (first !== undefined) {
      const pick = (right: 'call' | 'put'): number | null => {
        let best: number | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const q of snap.quotes) {
          if (q.contract.expiry !== first || q.contract.type !== right) continue;
          const delta = q.greeks?.delta;
          if (typeof delta !== 'number' || typeof q.impliedVolatility !== 'number') continue;
          const dist = Math.abs(Math.abs(delta) - 0.25);
          if (dist < bestDist) {
            bestDist = dist;
            best = q.impliedVolatility;
          }
        }
        return best;
      };
      const put = pick('put');
      const call = pick('call');
      if (put !== null && call !== null) skew25Delta = put - call;
    }
    return {
      asOf: asOfMs,
      atTheMoneyVolatilityByExpiry: atm,
      skew25Delta,
      markSources: { ...snapshotMarkSources },
      dividendRisk,
    };
  };

  // ---- the ledger's marks -----------------------------------------------------------------------------
  const marks: PortfolioValuationMark[] = [];
  const markEquity: number[] = [];
  let reconciliationResidual = 0;
  const recordMark = (snap: ChainSnapshot, asOfMs: EpochMs, equity: number): void => {
    const spots: Record<string, { price: number; currency: string }> = {};
    const anyUnderlying = book[0]?.underlying ?? hedgeUnderlying;
    if (anyUnderlying !== null && anyUnderlying !== undefined)
      spots[anyUnderlying] = { price: snap.underlyingPrice, currency: baseCurrency };
    for (const t of book) {
      spots[t.underlying] = { price: snap.underlyingPrice, currency: baseCurrency };
      if (t.position.legs.length === 0) continue;
      const m = markTrade(t, snap, asOfMs);
      m.perLeg.forEach((p, index) => {
        if (p.leg.kind === 'stock' || p.leg.quantity === 0) return;
        spots[t.live[index]!.instrumentId] = {
          price: Math.abs(p.value) / (Math.abs(p.leg.quantity) * t.position.multiplier),
          currency: baseCurrency,
        };
      });
    }
    const valuationDate = nextCalendarDate(dateOf(asOfMs));
    const market = createMarketSnapshot({
      asOf: isoDateToEpochMs(valuationDate),
      observations: { spots },
    });
    const nav =
      state === undefined
        ? initialCapital
        : portfolioSnapshot({ portfolio: state, asOf: isoDateToEpochMs(valuationDate), market })
            .netAssetValue;
    const residual = nav - equity;
    if (Math.abs(residual) > Math.abs(reconciliationResidual)) reconciliationResidual = residual;
    const last = marks[marks.length - 1];
    if (last !== undefined && last.valuationDate === valuationDate) {
      marks[marks.length - 1] = { valuationDate, market };
      markEquity[markEquity.length - 1] = equity;
    } else {
      marks.push({ valuationDate, market });
      markEquity.push(equity);
    }
  };

  // ---- the loop ----------------------------------------------------------------------------------------
  for (let step = 0; step < ordered.length; step += 1) {
    const { snap: rawSnap, asOfMs } = ordered[step]!;
    const nextAsOfMs = step + 1 < ordered.length ? ordered[step + 1]!.asOfMs : null;
    const snap = enrichSnapshot(rawSnap, asOfMs);
    const spot = snap.underlyingPrice;
    stamp(asOfMs);
    snapshotMarkSources = {
      snapshots: 0,
      currentQuote: 0,
      impliedFromPrice: 0,
      entryVolatility: 0,
      carried: 0,
    };

    applyCorporateActions(asOfMs);

    for (const t of [...book]) {
      if (!book.includes(t)) continue;
      const m = markTrade(t, snap, asOfMs);
      const dte = minDaysToExpiry(t.position, asOfMs);
      if (dte <= 0) {
        // Settle every expired leg; a multi-expiry trade keeps its far legs and stays open.
        const expiredAll = t.position.legs.every(
          (l) =>
            l.kind === 'stock' || l.expiry === undefined || daysToExpiry(asOfMs, l.expiry) <= 0,
        );
        if (expiredAll) {
          const anyAssigned = t.position.legs.some(
            (l) =>
              l.kind !== 'stock' &&
              l.quantity < 0 &&
              (l.kind === 'call' ? spot > l.strike : spot < l.strike),
          );
          closeTrade(t, snap, asOfMs, anyAssigned ? 'assignment' : 'expiry', true);
          continue;
        }
        settleLegs(
          t,
          snap,
          asOfMs,
          (leg) => leg.expiry !== undefined && daysToExpiry(asOfMs, leg.expiry) <= 0,
          null,
        );
        if (t.position.legs.every((l) => l.kind === 'stock')) {
          closeTrade(t, snap, asOfMs, 'expiry', false);
          continue;
        }
      }
      const liveMark = t.position.legs.length === 0 ? m : markTrade(t, snap, asOfMs);
      const context: ExitContext = {
        snapshot: snap,
        asOf: asOfMs,
        position: t.position,
        entryPremium: t.entryPremium,
        markToMarket: liveMark.pnl + t.settledPnl,
        pnlFraction: (liveMark.pnl + t.settledPnl) / (Math.abs(t.entryPremium) || 1),
        daysToExpiry: minDaysToExpiry(t.position, asOfMs),
        netDelta: liveMark.greeks.delta,
        greeks: liveMark.greeks,
      };
      const rollTriggers = roll ? (roll.when ?? exit) : null;
      if (rollTriggers && evaluateExit(rollTriggers, context)) {
        const ruleIndex = t.ruleIndex;
        closeTrade(t, snap, asOfMs, 'roll', false);
        tryEnter({
          ruleIndex: ruleIndex,
          snap,
          asOfMs,
          equityNow: cash + openOptionValue(snap, asOfMs) + hedgeShares * spot,
        });
      } else {
        const reason = evaluateExit(exit, context);
        if (reason) closeTrade(t, snap, asOfMs, reason, false);
      }
    }

    deepInTheMoneyAssignment(snap, asOfMs);
    const dividendRisk = dividendEvidence(snap, asOfMs, nextAsOfMs);

    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
      const gate = rules[ruleIndex]!.when ?? 'flat';
      // `'always'` keeps entering while the book has room and the rule keeps building; every other
      // gate enters at most once per snapshot.
      for (;;) {
        const before = book.length;
        tryEnter({
          ruleIndex: ruleIndex,
          snap,
          asOfMs,
          equityNow: cash + openOptionValue(snap, asOfMs) + hedgeShares * spot,
        });
        if (gate !== 'always' || book.length === before || book.length >= maximumOpenPositions)
          break;
      }
    }
    rehedge(snap, asOfMs);

    const equity = cash + openOptionValue(snap, asOfMs) + hedgeShares * spot;
    equityCurve.push(equity);
    timestamps.push(asOfMs);
    surface.push(surfaceRow(snap, asOfMs, dividendRisk));
    recordMark(snap, asOfMs, equity);
  }

  // A still-open trade is recorded as an open-at-end trade (marked, not cash-settled).
  const openAtEnd = book.length;
  if (book.length > 0 && ordered.length > 0) {
    const last = ordered[ordered.length - 1]!;
    const lastSnap = enrichSnapshot(last.snap, last.asOfMs);
    for (const t of [...book]) {
      const m = t.position.legs.length === 0 ? null : markTrade(t, lastSnap, last.asOfMs);
      discloseFallbacks(t);
      trades.push(
        tradeRow({
          t,
          position: t.position,
          live: t.live,
          snap: lastSnap,
          exitAsOf: null,
          reason: 'open-at-end',
          exitCosts: 0,
          m,
          markAsOf: last.asOfMs,
          grossPnl: (m === null ? 0 : m.pnl) + t.settledPnl,
        }),
      );
    }
  }

  // ---- the ledger's own reports and the reconciliation law ------------------------------------------
  const ledger = createPortfolioLedger({ portfolioId: runId, baseCurrency, events });
  let timeline: PortfolioTimelineResult | null = null;
  if (marks.length > 0 && state !== undefined) {
    if (!(Math.abs(reconciliationResidual) <= RECONCILIATION_TOLERANCE)) {
      throw new InputError(
        `${FN}: the ledger's net asset value differs from the engine's equity by ${reconciliationResidual} at a mark — an engine invariant failed; nothing was published.`,
        {
          code: ErrorCode.BacktestLedgerReconciliationFailed,
          context: { function: FN, residual: reconciliationResidual },
        },
      );
    }
    if (marks.length >= 2) timeline = portfolioTimeline({ ledger, valuationMarks: marks });
  }

  const points: EquityPoint[] = toEquityPoints(equityCurve, timestamps);
  const performance = analyze({ equity: equityCurve }, { periodsPerYear, riskFreeRate: rate });

  return {
    points,
    returns: simpleReturns(equityCurve),
    trades,
    settlements,
    fills,
    finalValue: equityCurve[equityCurve.length - 1]!,
    performance,
    limitRejections,
    fillRejections,
    surface,
    ledger: ledger.toJSON(),
    timeline: timeline as PortfolioTimelineResult,
    runId,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      initialCapital,
      riskFreeRate: rate,
      dividendYield,
      priceSource,
      sizing: sizingMode,
      commission: commission.label,
      slippage: slippage.label,
      assignment,
      hedge: hedge ? hedge.deltaBand : 'none',
      periodsPerYear,
      marking,
      book: { maximumOpenPositions, maximumPerUnderlying },
      limits: {
        maximumMarginFraction: limits.maximumMarginFraction ?? null,
        maximumNetDelta: limits.maximumNetDelta ?? null,
        maximumNetVega: limits.maximumNetVega ?? null,
        maximumConcentration: limits.maximumConcentration ?? null,
        scenarioLoss:
          limits.scenarioLoss === undefined
            ? null
            : {
                spotShocks: [...limits.scenarioLoss.spotShocks],
                volatilityShocks: [...limits.scenarioLoss.volatilityShocks],
                maximumLossFraction: limits.scenarioLoss.maximumLossFraction,
              },
      },
      fillPolicy: { mode: fillMode, partialFill, price: fillPrice },
      quoteFreshness: { maximumQuoteAgeMs: maximumFillQuoteAgeMs },
      rules: rules.map((rule, index) => ({
        id: ruleIds[index]!,
        structure: 'build' in rule ? 'build' : rule.structure,
      })),
      corporateActions: corporateActions.length,
      dividends: dividends.length,
      baseCurrency,
      ledger: { sourceId, accountId: ACCOUNT_ID, lotRelief: ledger.lotRelief },
      replayable,
    },
    diagnostics: {
      engine: 'options-backtest',
      method: 'chain-snapshot-driven',
      converged: true,
      warnings,
      snapshotCount: ordered.length,
      tradeCount: trades.length,
      openAtEnd,
      limitRejectionCount: limitRejections.length,
      fillRejectionCount: fillRejections.length,
      earlyAssignmentCount,
      corporateActionsApplied,
      reconciliationResidual,
    },
  };
}
