/**
 * `portfolioBacktest` (Stage 4.6, FC8 Decision 6): the ledger-backed multi-asset simulator. Decision
 * instants are the observation timestamps inside the window (a calendar restricts them to sessions);
 * at each instant the engine folds lifecycle facts, external flows, marks, the strategy's orders
 * through the execution policy, and a margin check — every one a portfolio event — and records the
 * ledger's valuation mark. The equity IS the ledger's net asset value; the timeline, the P&L, and the
 * performance summary are the portfolio and performance packages' own reports over it.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  WarningCode,
  InputError,
  type CorporateAction,
  type EpochMs,
  type QuantWarning,
  isoDateToEpochMs,
  warning,
} from '@totalfinance/core';
import type { Bar, OrderBook, Quote, Trade } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import { CBOE, NYSE, crypto24x7, type Calendar } from '@totalfinance/calendars';
import { selectQuotePrice } from '@totalfinance/options';
import { analyze } from '@totalfinance/performance';
import {
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  applyPortfolioEvents,
  createPortfolioLedger,
  isModelPortfolio,
  portfolioEventsFromFill,
  portfolioPnl,
  portfolioSnapshot,
  portfolioTimeline,
  proposePortfolioRebalance,
  requirePortfolioEventEnvelope,
  type AllocationTarget,
  type CurrencyPairQuote,
  type InstrumentClassification,
  type InvestmentPolicy,
  type NormalizedFill,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioPnlResult,
  type PortfolioState,
  type PortfolioTimelineResult,
  type PortfolioValuationMark,
} from '@totalfinance/portfolio';
import {
  execution as executionPolicies,
  describeExecutionPolicy,
  maintenanceMarginBreached,
} from '../execution/policy.js';
import { fillOrderWithPolicy } from '../execution/fill-order.js';
import { requireOrderIntent } from '../execution/validate.js';
import type { ExecutionPolicy, MarketObservation, OrderIntent } from '../execution/types.js';
import { toEquityPoints, type EquityPoint } from '../types.js';
import { equityToReturns } from '../vectorized.js';
import { resolveValuationAsOf } from '@totalfinance/core';
import type { OptionQuote } from '@totalfinance/core';
import { adapterFor } from './adapters.js';
import type {
  InstrumentAdapter,
  LatestObservations,
  LifecycleInput,
  LiquidationRow,
  OrderRecord,
  OrderSource,
  PortfolioBacktestRequest,
  PortfolioBacktestResult,
  PortfolioStepFrame,
  PortfolioStepper,
  InstrumentSpecification,
  PortfolioStepperRequest,
  PortfolioStrategy,
  PortfolioValuationInputs,
  RejectionRow,
  SessionContext,
} from './types.js';
import { requirePortfolioBacktestRequest, requirePortfolioStepperRequest } from './validate.js';

const FN = 'portfolioBacktest';
const ACCOUNT_ID = 'main';
const DAY_MS = 86_400_000;
const RECONCILIATION_TOLERANCE = 1e-9;

/** Rows in a canonical order for identity only — the engine's cursors already read them by time. */
function identityOrder<T>(
  rows: readonly T[],
  keyOf: (row: T) => readonly (string | number)[],
): T[] {
  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      const x = ka[i] ?? '';
      const y = kb[i] ?? '';
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}
const MAXIMUM_LIQUIDATION_ROUNDS = 8;

const dateOf = (ms: EpochMs): string =>
  new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
const nextCalendarDate = (date: string): string =>
  new Date(isoDateToEpochMs(date) + DAY_MS).toISOString().slice(0, 10);

const CALENDARS: Readonly<Record<string, Calendar>> = Object.freeze({
  NYSE,
  CBOE,
  ALWAYS_OPEN: crypto24x7,
});

const DEFAULT_SETTLEMENT: Readonly<Record<string, 0 | 1 | 2>> = Object.freeze({
  equity: 1,
  etf: 1,
  option: 1,
  bond: 1,
});

/** The period key of an instant under a rebalance frequency (a new key = a rebalance instant). */
function periodKey(date: string, frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'): string {
  if (frequency === 'daily') return date;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (frequency === 'monthly') return `${year}-${month}`;
  if (frequency === 'quarterly') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  // ISO week
  const d = new Date(isoDateToEpochMs(date));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${week}`;
}

/** A sorted series with a forward-only cursor: the latest row at or before an instant. */
class Series<T extends { timestampMs: EpochMs }> {
  private cursor = 0;
  constructor(private readonly rows: readonly T[]) {}
  latestAt(asOf: EpochMs): T | undefined {
    while (this.cursor < this.rows.length && this.rows[this.cursor]!.timestampMs <= asOf)
      this.cursor += 1;
    return this.cursor === 0 ? undefined : this.rows[this.cursor - 1];
  }
  private windowCursor = 0;
  /** Rows with `previous < timestampMs ≤ asOf` — instants ascend, so the window only moves forward. */
  between(previous: EpochMs | null, asOf: EpochMs): T[] {
    if (previous !== null) {
      while (
        this.windowCursor < this.rows.length &&
        this.rows[this.windowCursor]!.timestampMs <= previous
      )
        this.windowCursor += 1;
    }
    const out: T[] = [];
    for (
      let i = this.windowCursor;
      i < this.rows.length && this.rows[i]!.timestampMs <= asOf;
      i += 1
    )
      out.push(this.rows[i]!);
    return out;
  }
}

const byTime = <T extends { timestampMs: EpochMs }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.timestampMs - b.timestampMs);

/**
 * Run a ledger-backed multi-asset backtest. See `docs/specs/portfolio-scale-backtesting.md`
 * (Decision 6).
 */
export function portfolioBacktest(request: PortfolioBacktestRequest): PortfolioBacktestResult {
  requirePortfolioBacktestRequest(FN, 'request', request);
  const sim = simulation(FN, request, request.strategy);
  let pending: OrderIntent[] = [];
  for (let index = 0; index < sim.instants.length; index += 1) {
    sim.open(index);
    sim.close(index, pending);
    // The context contains a COMPLETED observation. Its decision can first trade the next
    // observation, never the open/range of the bar the strategy has just inspected. The final
    // instant is valuation-only: there is no subsequent observation to execute a new decision.
    pending = index + 1 < sim.instants.length ? sim.strategyOrders(sim.context(index)) : [];
  }
  return sim.finish();
}

const STEPPER_FN = 'createPortfolioStepper';

/**
 * The engine's seam (Stage 7B.1, Decision 2): the same per-instant loop `portfolioBacktest` runs,
 * driven from outside. `open(index)` stamps the clock, folds pre-open entitlements and external
 * flows, and returns a pre-execution context valued at opening or last-completed marks (the mark
 * source identifies carried prices). `close(index, orders)` executes the caller's orders through
 * the execution policy, settles close-derived derivative lifecycle, runs the margin check, records the valuation mark and the equity,
 * and returns the rows the step appended; `finish()` assembles the same result `portfolioBacktest`
 * returns over the instants closed so far. Calls must alternate `open(0)`, `close(0)`, `open(1)`, …
 * — an out-of-order call refuses and changes nothing; `finish()` may be called again and returns
 * the same result. The orders come from the caller, so the
 * result records `strategy: { kind: 'external', replayable: false }`; a trading environment saves
 * its own action trace to make an episode replayable.
 */
export function createPortfolioStepper(request: PortfolioStepperRequest): PortfolioStepper {
  const checked = requirePortfolioStepperRequest(STEPPER_FN, 'request', request);
  const sim = simulation(STEPPER_FN, checked, null);
  let nextIndex = 0;
  let opened: number | null = null;
  let finished = false;
  let result: PortfolioBacktestResult | null = null;
  const refuseStep = (message: string, code: ErrorCode = ErrorCode.InputWrongShape): never => {
    throw new InputError(`${STEPPER_FN}: ${message}`, {
      code,
      context: { function: STEPPER_FN, nextIndex, opened, finished },
    });
  };
  return Object.freeze({
    runId: sim.runId,
    instants: Object.freeze([...sim.instants]),
    open(index: number): SessionContext {
      if (finished) refuseStep('finish() has been called — create a new stepper to run again.');
      if (opened !== null)
        refuseStep(`instant ${opened} is open — close it before opening another.`);
      if (!Number.isSafeInteger(index))
        refuseStep(
          `open() takes the instant's index; received ${String(index)}.`,
          ErrorCode.InputWrongType,
        );
      if (index !== nextIndex)
        refuseStep(
          `open(${index}) is out of order — the next instant is ${nextIndex} of ${sim.instants.length}.`,
          ErrorCode.InputOutOfRange,
        );
      if (index >= sim.instants.length)
        refuseStep(
          `no instant ${index} — the run has ${sim.instants.length}; call finish().`,
          ErrorCode.InputOutOfRange,
        );
      opened = index;
      return sim.open(index);
    },
    close(index: number, orders: readonly OrderIntent[]): PortfolioStepFrame {
      if (opened === null || index !== opened)
        refuseStep(
          `close(${String(index)}) needs open(${String(index)}) first${
            opened === null ? '' : ` — instant ${opened} is the one open`
          }.`,
          ErrorCode.InputOutOfRange,
        );
      if (!Array.isArray(orders))
        refuseStep('orders must be an array of order intents.', ErrorCode.InputWrongType);
      orders.forEach((order, i) => requireOrderIntent(STEPPER_FN, `orders[${i}]`, order));
      const frame = sim.close(index, orders);
      opened = null;
      nextIndex = index + 1;
      return frame;
    },
    context(): SessionContext {
      if (opened !== null)
        refuseStep(`instant ${opened} is open — close it before reading its context.`);
      if (nextIndex === 0)
        refuseStep('no instant has been closed yet — open(0) and close(0) first.');
      return sim.context(nextIndex - 1);
    },
    valuation(): PortfolioValuationInputs {
      if (opened !== null)
        refuseStep(`instant ${opened} is open — close it before reading its valuation.`);
      if (nextIndex === 0)
        refuseStep('no instant has been closed yet — open(0) and close(0) first.');
      return sim.valuation(nextIndex - 1);
    },
    finish(): PortfolioBacktestResult {
      if (opened !== null) refuseStep(`instant ${opened} is open — close it before finish().`);
      if (result === null) result = sim.finish();
      finished = true;
      return result;
    },
  });
}

interface Simulation {
  readonly instants: readonly EpochMs[];
  readonly runId: string;
  open(index: number): SessionContext;
  close(index: number, orders: readonly OrderIntent[]): PortfolioStepFrame;
  context(index: number): SessionContext;
  valuation(index: number): PortfolioValuationInputs;
  finish(): PortfolioBacktestResult;
  strategyOrders(context: SessionContext): OrderIntent[];
}

/** The whole engine as closures over one run's state; `portfolioBacktest` and the stepper drive it. */
function simulation(
  FN: string,
  request: PortfolioStepperRequest,
  strategy: PortfolioStrategy | null,
): Simulation {
  const { accounting, marketData } = request;
  // Instruments are visited in id order everywhere — lifecycle facts, marks, the assumptions block —
  // so a request whose record keys arrive in another order (a canonically stored artifact input, a
  // caller's object literal) is the same run (Stage 7B.1 slice 4: a saved episode must replay).
  const instruments: Readonly<Record<string, InstrumentSpecification>> = Object.fromEntries(
    Object.keys(request.instruments)
      .sort()
      .map((id) => [id, request.instruments[id]!]),
  );
  const baseCurrency = accounting.baseCurrency;
  const lotRelief = accounting.lotRelief ?? 'fifo';
  const policy: ExecutionPolicy = request.execution ?? executionPolicies.simplified();
  const periodsPerYear = request.periodsPerYear ?? 252;
  const calendar = request.calendar === undefined ? null : CALENDARS[request.calendar]!;
  const from = request.window?.fromTimestampMs ?? null;
  const to = request.window?.toTimestampMs ?? null;
  const replayable =
    strategy !== null &&
    'model' in strategy &&
    Object.values(instruments).every((spec) => spec.kind !== 'custom');
  const adapters = new Map<string, InstrumentAdapter>();
  for (const [id, spec] of Object.entries(instruments)) adapters.set(id, adapterFor(id, spec));
  const classifications: Record<string, InstrumentClassification> = {};
  for (const [id, spec] of Object.entries(instruments)) {
    classifications[id] = {
      assetClass: spec.assetClass ?? spec.kind,
      ...(spec.classification ?? {}),
    };
  }
  const settlementLag = (id: string): 0 | 1 | 2 => {
    const spec = instruments[id]!;
    const assetClass = spec.assetClass ?? spec.kind;
    const declared = accounting.settlement?.[assetClass];
    if (declared !== undefined) return Number(declared.slice(2)) as 0 | 1 | 2;
    return DEFAULT_SETTLEMENT[assetClass] ?? 0;
  };
  const settleInstant = (asOf: EpochMs, lag: 0 | 1 | 2): EpochMs | undefined => {
    if (lag === 0) return undefined;
    const date = dateOf(asOf);
    const settled =
      calendar === null
        ? new Date(isoDateToEpochMs(date) + lag * DAY_MS).toISOString().slice(0, 10)
        : calendar.addBusinessDays(date, lag);
    return isoDateToEpochMs(settled) + (asOf - isoDateToEpochMs(date));
  };

  // ---- the observation index ------------------------------------------------------------------------
  const group = <T extends { symbol: string; timestampMs: EpochMs }>(
    rows: readonly T[] | undefined,
  ): Map<string, Series<T>> => {
    const map = new Map<string, T[]>();
    for (const row of rows ?? []) {
      const list = map.get(row.symbol);
      if (list) list.push(row);
      else map.set(row.symbol, [row]);
    }
    return new Map([...map.entries()].map(([id, list]) => [id, new Series(byTime(list))]));
  };
  const bars = group<Bar>(marketData.bars);
  const quotes = group<Quote>(marketData.quotes);
  const trades = group<Trade>(marketData.trades);
  const books = group<OrderBook>(marketData.orderBooks);
  const chains = byTime(
    (marketData.optionChains ?? []).map((snap) => ({
      timestampMs: resolveValuationAsOf(snap.asOf, FN),
      snap,
    })),
  );
  const chainSeries = new Series(chains);
  const forwardRates = new Map<string, Series<{ timestampMs: EpochMs; forwardRate: number }>>();
  for (const [id, rows] of groupBy(marketData.forwardRates ?? [], (r) => r.instrumentId))
    forwardRates.set(id, new Series(byTime(rows)));
  const fundingRates = new Map<
    string,
    Series<{ timestampMs: EpochMs; fundingRate: number; instrumentId: string }>
  >();
  for (const [id, rows] of groupBy(marketData.fundingRates ?? [], (r) => r.instrumentId))
    fundingRates.set(id, new Series(byTime(rows)));
  const fxSeries = new Map<
    string,
    Series<{
      timestampMs: EpochMs;
      quotePerBase: number;
      baseCurrency: string;
      quoteCurrency: string;
    }>
  >();
  for (const [pair, rows] of groupBy(
    marketData.fxRates ?? [],
    (r) => `${r.baseCurrency}/${r.quoteCurrency}`,
  ))
    fxSeries.set(pair, new Series(byTime(rows)));
  const dividends = [...(marketData.dividends ?? [])].sort((a, b) =>
    a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0,
  );
  const coupons = [...(marketData.coupons ?? [])].sort((a, b) =>
    a.paymentDate < b.paymentDate ? -1 : a.paymentDate > b.paymentDate ? 1 : 0,
  );
  const corporateActions = [...(marketData.corporateActions ?? [])].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0,
  );
  const dividendsBy = groupBy(dividends, (d) => d.instrumentId);
  const couponsBy = groupBy(coupons, (c) => c.instrumentId);
  const actionsBy = groupBy(corporateActions, (a) => a.symbol);
  const externalFlows = byTime(request.externalFlows ?? []);

  // ---- the decision instants -------------------------------------------------------------------------
  const instantSet = new Set<EpochMs>();
  const collect = (rows: Iterable<{ timestampMs: EpochMs }>): void => {
    for (const row of rows) instantSet.add(row.timestampMs);
  };
  for (const source of [
    marketData.bars,
    marketData.quotes,
    marketData.trades,
    marketData.orderBooks,
    marketData.forwardRates,
    marketData.fundingRates,
  ])
    if (source !== undefined) collect(source);
  collect(chains);
  const instants = [...instantSet]
    .filter((ms) => (from === null || ms >= from) && (to === null || ms <= to))
    .filter((ms) => calendar === null || calendar.isBusinessDay(dateOf(ms)))
    .sort((a, b) => a - b);

  const runId = contentHash({
    accounting: {
      baseCurrency,
      initialCash: accounting.initialCash,
      lotRelief,
      settlement: accounting.settlement ?? null,
    },
    instruments: Object.fromEntries(
      Object.entries(instruments).map(([id, spec]) => [
        id,
        {
          ...spec,
          adapter:
            spec.adapter === undefined
              ? undefined
              : { kind: spec.adapter.kind, version: spec.adapter.version },
        },
      ]),
    ),
    strategy:
      strategy === null
        ? { external: 'stepper' }
        : 'model' in strategy
          ? {
              model: strategy.model,
              schedule: strategy.schedule,
              policy: strategy.policy ?? null,
              scope: strategy.scope ?? 'to-target',
            }
          : { onSession: 'callback' },
    execution: describeExecutionPolicy(policy),
    externalFlows,
    calendar: request.calendar ?? null,
    window: { from, to },
    periodsPerYear,
    seed: request.seed ?? null,
    // Identity is order-invariant where the engine is: every row set is read through time-ordered
    // cursors keyed by instrument, so two requests that differ only in row order are the same run
    // (FC8 ordering invariance). Each set is hashed in its canonical order.
    marketData: contentHash({
      bars: identityOrder(marketData.bars ?? [], (r) => [r.timestampMs, r.symbol]),
      quotes: identityOrder(marketData.quotes ?? [], (r) => [r.timestampMs, r.symbol]),
      trades: identityOrder(marketData.trades ?? [], (r) => [
        r.timestampMs,
        r.symbol,
        r.sequence ?? '',
      ]),
      orderBooks: identityOrder(marketData.orderBooks ?? [], (r) => [r.timestampMs, r.symbol]),
      optionChains: identityOrder(marketData.optionChains ?? [], (r) => [
        resolveValuationAsOf(r.asOf, FN),
      ]),
      fxRates: identityOrder(marketData.fxRates ?? [], (r) => [
        r.timestampMs,
        r.baseCurrency,
        r.quoteCurrency,
      ]),
      forwardRates: identityOrder(marketData.forwardRates ?? [], (r) => [
        r.timestampMs,
        r.instrumentId,
      ]),
      fundingRates: identityOrder(marketData.fundingRates ?? [], (r) => [
        r.timestampMs,
        r.instrumentId,
      ]),
      corporateActions: identityOrder(corporateActions, (r) => [r.effectiveDate, r.symbol, r.type]),
      dividends: identityOrder(dividends, (r) => [r.exDate, r.instrumentId]),
      coupons: identityOrder(coupons, (r) => [r.paymentDate, r.instrumentId]),
    }),
  });
  const sourceId = `backtest:portfolio:${runId}`;

  // ---- the ledger --------------------------------------------------------------------------------------
  const events: PortfolioEventEnvelope[] = [];
  let state: PortfolioState | undefined;
  let eventSequence = 0;
  let eventClock = 0;
  const stamp = (asOf: EpochMs): EpochMs => {
    if (asOf > eventClock) eventClock = asOf;
    return eventClock;
  };
  const fold = (batch: PortfolioEventEnvelope[]): void => {
    if (batch.length === 0) return;
    state =
      state === undefined
        ? applyPortfolioEvents({
            portfolio: { baseCurrency, lotRelief, portfolioId: runId },
            events: batch,
          })
        : applyPortfolioEvents({ previousState: state, events: batch });
    events.push(...batch);
  };
  const envelope = (
    asOf: EpochMs,
    event: PortfolioEvent,
    correlationId?: string,
  ): PortfolioEventEnvelope => {
    eventSequence += 1;
    const at = stamp(asOf);
    return {
      eventId: `${runId}:e${eventSequence}`,
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      eventType: event.eventType,
      sourceId,
      accountId: ACCOUNT_ID,
      effectiveTimestampMs: at,
      recordedTimestampMs: at,
      ...(correlationId !== undefined ? { correlationId } : {}),
      event,
      provenance: {},
    };
  };
  const account = () => state?.accounts[ACCOUNT_ID];
  const heldQuantity = (id: string): number => account()?.positions[id]?.quantity ?? 0;

  const orders: OrderRecord[] = [];
  const fills: NormalizedFill[] = [];
  const rejections: RejectionRow[] = [];
  const liquidations: LiquidationRow[] = [];
  const warnings: QuantWarning[] = [];
  const marks: PortfolioValuationMark[] = [];
  const markEquity: number[] = [];
  const timestamps: EpochMs[] = [];
  const navSeries: number[] = [];
  let lifecycleEventCount = 0;
  let externalFlowCount = 0;
  let reconciliationResidual = 0;
  let fillSequence = 0;

  // ---- observations at an instant --------------------------------------------------------------------
  const latestFor = (id: string, asOf: EpochMs): LatestObservations => {
    const latest: LatestObservations = {};
    const bar = bars.get(id)?.latestAt(asOf);
    if (bar !== undefined) latest.bar = bar;
    const quote = quotes.get(id)?.latestAt(asOf);
    if (quote !== undefined) latest.quote = quote;
    const trade = trades.get(id)?.latestAt(asOf);
    if (trade !== undefined) latest.trade = trade;
    const book = books.get(id)?.latestAt(asOf);
    if (book !== undefined) latest.orderBook = book;
    const spec = instruments[id]!;
    if (spec.kind === 'option' && spec.contract?.kind === 'option') {
      const chain = chainSeries.latestAt(asOf)?.snap;
      if (chain !== undefined) {
        const terms = spec.contract;
        const expiryDate = dateOf(terms.expiryTimestampMs);
        const match = chain.quotes.filter(
          (q: OptionQuote) =>
            q.contract.type === terms.type &&
            q.contract.strike === terms.strikePricePerUnit &&
            q.contract.expiry === expiryDate,
        );
        if (match.length === 1) latest.chainQuote = match[0]!;
        latest.underlyingPrice = chain.underlyingPrice;
      }
    }
    const forward = forwardRates.get(id)?.latestAt(asOf);
    if (forward !== undefined) latest.forwardRate = forward.forwardRate;
    return latest;
  };
  const markCache = new Map<string, { pricePerUnit: number; source: string } | null>();
  const previousMarks = new Map<string, { pricePerUnit: number; source: string }>();
  const completedMarks = new Map<string, number>();
  const markOf = (id: string, asOf: EpochMs): { pricePerUnit: number; source: string } | null => {
    const key = `${id}@${asOf}`;
    const hit = markCache.get(key);
    if (hit !== undefined) return hit;
    const spec = instruments[id]!;
    const outcome = adapters.get(id)!.mark({
      instrumentId: id,
      specification: spec,
      asOf,
      latest: latestFor(id, asOf),
      previous: previousMarks.get(id) ?? null,
    });
    const mark = 'unavailable' in outcome ? null : outcome;
    if (mark !== null) {
      if (!Number.isFinite(mark.pricePerUnit)) {
        throw new InputError(
          `${FN}: the '${spec.kind}' adapter marked ${id} at a non-finite price at ${asOf}.`,
          {
            code: ErrorCode.BacktestAdapterNonconformant,
            context: { function: FN, instrumentId: id, asOf },
          },
        );
      }
      previousMarks.set(id, mark);
    }
    markCache.set(key, mark);
    return mark;
  };
  // Bar opens precede their completed range/close. Point observations (option chains and FX
  // forwards included) have no separate opening price: collateral carries the last completed
  // mark until that observation is processed. Never invent intrinsic to replace an expiry quote.
  const openingMarkOf = (
    id: string,
    asOf: EpochMs,
  ): { pricePerUnit: number; source: string } | null => {
    const spec = instruments[id]!;
    const bar = latestFor(id, asOf).bar;
    if (
      policy.observation === 'bar' &&
      spec.kind !== 'option' &&
      spec.kind !== 'fx-forward' &&
      bar?.timestampMs === asOf
    ) {
      const accrued = adapters.get(id)!.accrued?.({ specification: spec, asOf }) ?? 0;
      return {
        pricePerUnit: bar.open + accrued,
        source: accrued === 0 ? 'bar.open' : 'bar.open+accrued',
      };
    }
    const completed = completedMarks.get(id);
    return completed === undefined
      ? markOf(id, asOf)
      : { pricePerUnit: completed, source: 'last-completed' };
  };
  const requireMark = (
    id: string,
    asOf: EpochMs,
    markFor = markOf,
  ): { pricePerUnit: number; source: string } => {
    const mark = markFor(id, asOf);
    if (mark === null) {
      throw new InputError(
        `${FN}: ${id} is held at ${asOf} but its '${instruments[id]!.kind}' adapter has no mark from the supplied observations — an unavailable mark is a typed failure, never a guess. Supply a bar, quote, trade, order book, chain quote, or forward rate at or before the instant.`,
        {
          code: ErrorCode.BacktestMarkUnavailable,
          context: { function: FN, instrumentId: id, asOf },
        },
      );
    }
    return mark;
  };
  const conversionsAt = (asOf: EpochMs, currencies: Iterable<string>): CurrencyPairQuote[] => {
    const out: CurrencyPairQuote[] = [];
    for (const currency of new Set(currencies)) {
      if (currency === baseCurrency) continue;
      const direct = fxSeries.get(`${currency}/${baseCurrency}`)?.latestAt(asOf);
      const inverse = fxSeries.get(`${baseCurrency}/${currency}`)?.latestAt(asOf);
      const row = direct ?? inverse;
      if (row === undefined) {
        throw new InputError(
          `${FN}: no fxRates quote between ${currency} and ${baseCurrency} at or before ${asOf} — every non-base currency the portfolio holds needs a dated quote.`,
          {
            code: ErrorCode.InputMissingField,
            context: { function: FN, field: 'marketData.fxRates', currency, asOf },
          },
        );
      }
      out.push({
        baseCurrency: row.baseCurrency,
        quoteCurrency: row.quoteCurrency,
        quotePerBase: row.quotePerBase,
      });
    }
    return out;
  };
  const heldCurrencies = (): string[] => {
    const acc = account();
    if (acc === undefined) return [];
    return [
      ...Object.keys(acc.cashBalances),
      ...Object.values(acc.positions).map((p) => p.currency),
    ];
  };
  const marketAt = (asOf: EpochMs, markFor = markOf): ReturnType<typeof createMarketSnapshot> => {
    const spots: Record<string, { price: number; currency: string }> = {};
    const acc = account();
    if (acc !== undefined) {
      for (const position of Object.values(acc.positions)) {
        if (position.quantity === 0) continue;
        const mark = requireMark(position.instrumentId, asOf, markFor);
        spots[position.instrumentId] = { price: mark.pricePerUnit, currency: position.currency };
      }
    }
    return createMarketSnapshot({ asOf, observations: { spots } });
  };
  const navAt = (asOf: EpochMs): number => {
    if (state === undefined) return 0;
    return portfolioSnapshot({
      portfolio: state,
      asOf,
      market: marketAt(asOf),
      currencyConversions: conversionsAt(asOf, heldCurrencies()),
    }).netAssetValue;
  };

  // ---- execution -------------------------------------------------------------------------------------
  const observationFor = (id: string, asOf: EpochMs): MarketObservation | null => {
    const latest = latestFor(id, asOf);
    const spec = instruments[id]!;
    if (spec.kind === 'option') {
      const q = latest.chainQuote;
      if (q === undefined) return null;
      const price = selectQuotePrice(q, 'mid');
      if (price === undefined || !Number.isFinite(price)) return null;
      const timestampMs = chainSeries.latestAt(asOf)!.timestampMs;
      return {
        kind: 'bar',
        bar: { symbol: id, timestampMs, open: price, high: price, low: price, close: price },
      };
    }
    if (spec.kind === 'fx-forward') {
      if (latest.forwardRate === undefined) return null;
      const r = latest.forwardRate;
      const timestampMs = forwardRates.get(id)!.latestAt(asOf)!.timestampMs;
      return {
        kind: 'bar',
        bar: { symbol: id, timestampMs, open: r, high: r, low: r, close: r },
      };
    }
    switch (policy.observation) {
      case 'bar':
        return latest.bar === undefined ? null : { kind: 'bar', bar: latest.bar };
      case 'quote':
        return latest.quote === undefined ? null : { kind: 'quote', quote: latest.quote };
      case 'trade':
        return latest.trade === undefined ? null : { kind: 'trade', trade: latest.trade };
      case 'order-book':
        return latest.orderBook === undefined
          ? null
          : { kind: 'order-book', book: latest.orderBook };
    }
  };
  const execute = (
    order: OrderIntent,
    asOf: EpochMs,
    source: OrderSource,
  ): NormalizedFill | null => {
    const spec = instruments[order.instrumentId];
    const record: OrderRecord = {
      orderId: order.orderId,
      asOf,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      type: order.type,
      source,
      outcome: 'unfilled',
      filledQuantity: 0,
      reason: null,
    };
    orders.push(record);
    if (spec === undefined) {
      record.reason = 'unknown instrument';
      rejections.push({
        asOf,
        orderId: order.orderId,
        instrumentId: order.instrumentId,
        code: ErrorCode.BacktestUniverseMembershipUnknown,
        detail: `${order.instrumentId} is not an instrument of this run`,
      });
      return null;
    }
    let observation = observationFor(order.instrumentId, asOf);
    if (observation === null) {
      record.reason = 'no-observation';
      rejections.push({
        asOf,
        orderId: order.orderId,
        instrumentId: order.instrumentId,
        code: WarningCode.BacktestDataMissing,
        detail: `no '${policy.observation}' observation for ${order.instrumentId} at ${asOf}`,
      });
      return null;
    }
    const observedAt =
      observation.kind === 'bar'
        ? observation.bar.timestampMs
        : observation.kind === 'quote'
          ? observation.quote.timestampMs
          : observation.kind === 'trade'
            ? observation.trade.timestampMs
            : observation.book.timestampMs;
    if (source === 'strategy' && observedAt <= order.submittedTimestampMs) {
      record.reason = 'observation must follow the decision';
      rejections.push({
        asOf,
        orderId: order.orderId,
        instrumentId: order.instrumentId,
        code: WarningCode.BacktestLookahead,
        detail: `the execution observation (${observedAt}) must be later than submittedTimestampMs (${order.submittedTimestampMs}); a completed bar cannot execute its own decision`,
      });
      return null;
    }
    // Maintenance is assessed at the completed mark. A forced close must not travel back to
    // that bar's open either; the simplified liquidation assumption is the contemporaneous close.
    if (source === 'liquidation' && observation.kind === 'bar') {
      const price = observation.bar.close;
      observation = {
        kind: 'bar',
        bar: { ...observation.bar, open: price, high: price, low: price },
      };
    }
    const adapter = adapters.get(order.instrumentId)!;
    const terms = adapter.fillTerms(spec);
    const lag = spec.kind === 'fx-forward' ? null : settlementLag(order.instrumentId);
    const settle =
      spec.kind === 'fx-forward'
        ? spec.forward!.maturityTimestampMs
        : lag === null
          ? undefined
          : settleInstant(asOf, lag);
    const accruedPerUnit = adapter.accrued?.({ specification: spec, asOf }) ?? 0;
    const executed = fillOrderWithPolicy({
      policy,
      order,
      observation,
      asOf,
      accountId: ACCOUNT_ID,
      currency: spec.currency,
      fillId: `${runId}:fill:${fillSequence + 1}`,
      filledTimestampMs: stamp(asOf),
      terms,
      ...(settle !== undefined ? { settleTimestampMs: settle } : {}),
      ...(accruedPerUnit !== 0 ? { accruedPerUnit } : {}),
    });
    if (executed.outcome !== 'filled') {
      record.reason = executed.reason;
      rejections.push({
        asOf,
        orderId: order.orderId,
        instrumentId: order.instrumentId,
        code: `backtest.unfilled.${executed.reason}`,
        detail: executed.detail,
      });
      return null;
    }
    const { fill, decision } = executed;
    const batch = portfolioEventsFromFill({
      fill,
      sourceId,
      recordedTimestampMs: fill.filledTimestampMs,
    });
    if (source === 'strategy' && state !== undefined) {
      const projected = applyPortfolioEvents({ previousState: state, events: batch });
      const spots: Record<string, { price: number; currency: string }> = {};
      // Do not finance a next-open purchase with gains from that bar's not-yet-known close.
      // The traded asset is marked at its executable dirty price; other holdings use causal
      // opening/last-completed marks, including the liability for a short bond's accrued receipt.
      for (const position of Object.values(projected.accounts[ACCOUNT_ID]!.positions)) {
        if (position.quantity === 0) continue;
        const id = position.instrumentId;
        spots[id] = {
          price:
            id === order.instrumentId
              ? fill.pricePerUnit + accruedPerUnit
              : requireMark(id, asOf, openingMarkOf).pricePerUnit,
          currency: position.currency,
        };
      }
      const snapshot = portfolioSnapshot({
        portfolio: projected,
        asOf,
        market: createMarketSnapshot({ asOf, observations: { spots } }),
        currencyConversions: conversionsAt(asOf, [
          ...Object.keys(projected.accounts[ACCOUNT_ID]!.cashBalances),
          ...Object.values(projected.accounts[ACCOUNT_ID]!.positions).map((p) => p.currency),
        ]),
      });
      const before = heldQuantity(order.instrumentId);
      const after = projected.accounts[ACCOUNT_ID]!.positions[order.instrumentId]?.quantity ?? 0;
      const reducing =
        before !== 0 &&
        (after === 0 || Math.sign(after) === Math.sign(before)) &&
        Math.abs(after) < Math.abs(before);
      const gross = snapshot.positions.reduce(
        (sum, p) => sum + Math.abs(p.baseCurrencyNotionalValue),
        0,
      );
      const required = gross * policy.margin.initialMarginRate;
      const equity = Math.max(0, snapshot.netAssetValue);
      const available = equity * policy.margin.buyingPowerMultiplier;
      const cashAccount = policy.margin.buyingPowerMultiplier <= 1;
      const unfinancedCash =
        cashAccount &&
        snapshot.cash.some((c) => c.settledAmount - c.unsettledPayable < -RECONCILIATION_TOLERANCE);
      if (
        !reducing &&
        (required > equity + RECONCILIATION_TOLERANCE ||
          gross > available + RECONCILIATION_TOLERANCE ||
          unfinancedCash)
      ) {
        record.reason = 'insufficient buying power';
        rejections.push({
          asOf,
          orderId: order.orderId,
          instrumentId: order.instrumentId,
          code: WarningCode.BacktestLimitRejected,
          detail: `entry requires ${required} initial margin against ${equity} equity and ${gross} gross exposure against ${available} buying power, including fees and existing exposure${unfinancedCash ? '; cash must cover unsettled payables without spending unsettled receivables' : ''}`,
        });
        return null;
      }
    }
    fillSequence += 1;
    fills.push(fill);
    fold(batch);
    record.outcome = decision.partial ? 'partial' : 'filled';
    record.filledQuantity = fill.quantity;
    return fill;
  };

  // ---- lifecycle -------------------------------------------------------------------------------------
  const factsFor = (id: string, previous: EpochMs | null, asOf: EpochMs) => {
    const previousDate = previous === null ? null : dateOf(previous);
    const date = dateOf(asOf);
    const inWindow = (d: string): boolean =>
      d <= date && (previousDate === null || d > previousDate);
    return {
      dividends: (dividendsBy.get(id) ?? []).filter((d) => inWindow(d.exDate)),
      coupons: (couponsBy.get(id) ?? []).filter((c) => inWindow(c.paymentDate)),
      fundingRates: fundingRates.get(id)?.between(previous, asOf) ?? [],
      corporateActions: (actionsBy.get(id) ?? []).filter((a) => inWindow(a.effectiveDate)),
    };
  };
  const underlyingMarkOf = (id: string, asOf: EpochMs): number | null => {
    const spec = instruments[id]!;
    const contract = spec.contract;
    if (contract === undefined) return null;
    const underlying = contract.underlyingInstrumentId;
    if (underlying in instruments) return markOf(underlying, asOf)?.pricePerUnit ?? null;
    if (spec.kind === 'option') return latestFor(id, asOf).underlyingPrice ?? null;
    return null;
  };
  const runLifecycle = (
    previous: EpochMs | null,
    asOf: EpochMs,
    last: boolean,
    phase: 'open' | 'close',
  ): void => {
    const acc = account();
    if (acc === undefined) return;
    for (const id of Object.keys(instruments)) {
      const spec = instruments[id]!;
      // Calendar entitlements/principal are known before the opening trade. Derivative
      // settlement, funding and rolls consume this observation's close/point mark and must
      // neither finance its earlier opening fills nor miss positions acquired by those fills.
      // Custom lifecycle may also depend on its mark, so it belongs to the close phase.
      const closeDerived =
        spec.kind === 'option' ||
        spec.kind === 'future' ||
        spec.kind === 'crypto-perpetual' ||
        spec.kind === 'fx-forward' ||
        spec.kind === 'custom';
      if (closeDerived !== (phase === 'close')) continue;
      const position = acc.positions[id];
      const held =
        position !== undefined && position.quantity !== 0
          ? { quantity: position.quantity, contractMultiplier: position.contractMultiplier }
          : null;
      const facts = factsFor(id, previous, asOf);
      const anyFact =
        facts.dividends.length +
          facts.coupons.length +
          facts.fundingRates.length +
          facts.corporateActions.length >
        0;
      const expiring =
        spec.contract !== undefined &&
        spec.contract.kind !== 'perpetual' &&
        asOf >= spec.contract.expiryTimestampMs &&
        (previous === null || previous < spec.contract.expiryTimestampMs);
      const maturing =
        spec.forward !== undefined &&
        asOf >= spec.forward.maturityTimestampMs &&
        (previous === null || previous < spec.forward.maturityTimestampMs);
      const bondMaturing =
        spec.coupon !== undefined &&
        asOf >= isoDateToEpochMs(spec.coupon.maturityDate) &&
        (previous === null || previous < isoDateToEpochMs(spec.coupon.maturityDate));
      const marks = spec.kind === 'future' || spec.kind === 'crypto-perpetual';
      if (held === null || (!anyFact && !expiring && !maturing && !bondMaturing && !marks))
        continue;
      const input: LifecycleInput = {
        instrumentId: id,
        specification: spec,
        asOf,
        previousAsOf: previous,
        held,
        mark: markOf(id, asOf),
        underlyingMark: underlyingMarkOf(id, asOf),
        facts,
        last,
      };
      const payloads = adapters.get(id)!.lifecycle(input);
      const batch = payloads.map((payload) => {
        const env = envelope(asOf, payload, `${runId}:lifecycle:${id}`);
        requirePortfolioEventEnvelope(FN, `instruments.${id}.adapter.lifecycle`, env);
        return env;
      });
      lifecycleEventCount += batch.length;
      fold(batch);
      // a future or perpetual at its expiry / an fx-forward at maturity: the position closes at the mark
      if ((spec.kind === 'future' && expiring) || (spec.kind === 'fx-forward' && maturing)) {
        const now = account()?.positions[id];
        if (now !== undefined && now.quantity !== 0) {
          const mark =
            spec.kind === 'fx-forward'
              ? spec.forward!.contractRate
              : requireMark(id, asOf).pricePerUnit;
          const closing = envelope(
            asOf,
            {
              eventType: 'trade.fill',
              instrumentId: id,
              side: now.quantity > 0 ? 'sell' : 'buy',
              quantity: Math.abs(now.quantity),
              pricePerUnit: mark,
              currency: now.currency,
              contractMultiplier: now.contractMultiplier,
              settlementStyle: now.settlementStyle,
              ...(now.contract !== undefined ? { contract: now.contract } : {}),
            },
            `${runId}:lifecycle:${id}`,
          );
          lifecycleEventCount += 1;
          fold([closing]);
        }
      }
      // a declared roll: close the expiring future into its successor at the two marks
      if (spec.kind === 'future' && spec.roll !== undefined && spec.contract?.kind === 'future') {
        const now = account()?.positions[id];
        const expiryMs = spec.contract.expiryTimestampMs;
        if (now !== undefined && now.quantity !== 0) {
          const sessionsLeft = instants.filter((ms) => ms > asOf && ms < expiryMs).length;
          if (sessionsLeft <= spec.roll.sessionsBeforeExpiry) {
            const successor = instruments[spec.roll.toInstrumentId]!;
            const closePrice = requireMark(id, asOf).pricePerUnit;
            const openPrice = requireMark(spec.roll.toInstrumentId, asOf).pricePerUnit;
            const roll = envelope(
              asOf,
              {
                eventType: 'derivative.roll',
                fromInstrumentId: id,
                toInstrumentId: spec.roll.toInstrumentId,
                quantity: Math.abs(now.quantity),
                closePricePerUnit: closePrice,
                openPricePerUnit: openPrice,
                ...(successor.contract !== undefined ? { contract: successor.contract } : {}),
              },
              `${runId}:lifecycle:${id}`,
            );
            lifecycleEventCount += 1;
            fold([roll]);
          }
        }
      }
    }
  };

  // ---- the strategy ----------------------------------------------------------------------------------
  let lastPeriodKey: string | null = null;
  let orderSequence = 0;
  const sessionContext = (asOf: EpochMs, index: number, markFor = markOf): SessionContext => {
    const acc = account();
    const snapshot =
      state === undefined
        ? null
        : portfolioSnapshot({
            portfolio: state,
            asOf,
            market: marketAt(asOf, markFor),
            currencyConversions: conversionsAt(asOf, heldCurrencies()),
          });
    const valued = new Map((snapshot?.positions ?? []).map((p) => [p.instrumentId, p]));
    return {
      asOf,
      index,
      netAssetValue: snapshot === null ? 0 : snapshot.netAssetValue,
      cash:
        acc === undefined
          ? []
          : Object.entries(acc.cashBalances).map(([currency, balance]) => ({
              currency,
              amount: balance.totalAmount,
            })),
      positions:
        acc === undefined
          ? []
          : Object.values(acc.positions)
              .filter((p) => p.quantity !== 0)
              .map((p) => ({
                instrumentId: p.instrumentId,
                quantity: p.quantity,
                contractMultiplier: p.contractMultiplier,
                markPricePerUnit: markFor(p.instrumentId, asOf)?.pricePerUnit ?? null,
                baseCurrencyMarketValue:
                  valued.get(p.instrumentId)?.baseCurrencyNotionalValue ?? null,
                currency: p.currency,
              })),
      observations: Object.fromEntries(
        Object.keys(instruments).map((id) => [id, latestFor(id, asOf)]),
      ),
      marks: Object.fromEntries(Object.keys(instruments).map((id) => [id, markFor(id, asOf)])),
      instruments,
    };
  };
  const valuation = (index: number): PortfolioValuationInputs => {
    const asOf = instants[index]!;
    if (state === undefined) {
      throw new InputError(`${FN}: no ledger state exists before the opening deposit.`, {
        code: ErrorCode.InputWrongShape,
        context: { function: FN, asOf },
      });
    }
    const market = marketAt(asOf);
    const currencyConversions = conversionsAt(asOf, heldCurrencies());
    return {
      asOf,
      portfolio: state,
      market,
      currencyConversions,
      snapshot: portfolioSnapshot({ portfolio: state, asOf, market, currencyConversions }),
    };
  };
  const strategyOrders = (context: SessionContext): OrderIntent[] => {
    if (strategy === null) {
      throw new InputError(`${FN}: the stepper has no strategy — its orders come from close().`, {
        code: ErrorCode.InputWrongShape,
        context: { function: FN },
      });
    }
    const { asOf } = context;
    if ('onSession' in strategy) {
      const intents = strategy.onSession(context);
      if (!Array.isArray(intents)) {
        throw new InputError(
          `${FN}: strategy.onSession must return an array of order intents at ${asOf}.`,
          { code: ErrorCode.InputWrongType, context: { function: FN, asOf } },
        );
      }
      intents.forEach((intent, i) => requireOrderIntent(FN, `strategy.onSession()[${i}]`, intent));
      return intents;
    }
    const key = periodKey(dateOf(asOf), strategy.schedule.frequency);
    if (key === lastPeriodKey) return [];
    lastPeriodKey = key;
    if (state === undefined) return [];
    const model = strategy.model;
    const investmentPolicy: InvestmentPolicy = {
      ...(strategy.policy ?? {}),
      ...(isModelPortfolio(model) ? { model } : { targets: model as AllocationTarget[] }),
    };
    const spots: Record<string, { price: number; currency: string }> = {};
    for (const id of Object.keys(instruments)) {
      const mark = markOf(id, asOf);
      if (mark !== null)
        spots[id] = { price: mark.pricePerUnit, currency: instruments[id]!.currency };
    }
    const proposal = proposePortfolioRebalance({
      portfolio: state,
      market: createMarketSnapshot({ asOf, observations: { spots } }),
      asOf,
      currencyConversions: conversionsAt(asOf, [
        ...heldCurrencies(),
        ...Object.values(instruments).map((s) => s.currency),
      ]),
      policy: investmentPolicy,
      instrumentClassification: classifications,
      scope: strategy.scope ?? 'to-target',
    });
    for (const target of proposal.unresolvedTargets) {
      warnings.push(
        warning(
          WarningCode.BacktestDataMissing,
          `${FN}: at ${asOf} the target ${JSON.stringify(target)} could not be resolved by proposePortfolioRebalance; it was not traded.`,
          'warn',
          { asOf },
        ),
      );
    }
    return proposal.trades.map((trade) => {
      orderSequence += 1;
      return {
        orderId: `${runId}:o${orderSequence}`,
        instrumentId: trade.instrumentId,
        side: trade.side,
        quantity: trade.quantity,
        type: 'market',
        submittedTimestampMs: asOf,
      } as OrderIntent;
    });
  };

  // ---- margin ------------------------------------------------------------------------------------------
  const marginCheck = (asOf: EpochMs): void => {
    const margin = policy.margin;
    if (state === undefined) return;
    for (let round = 0; round < MAXIMUM_LIQUIDATION_ROUNDS; round += 1) {
      const snapshot = portfolioSnapshot({
        portfolio: state,
        asOf,
        market: marketAt(asOf),
        currencyConversions: conversionsAt(asOf, heldCurrencies()),
      });
      const gross = snapshot.positions.reduce(
        (sum, p) => sum + Math.abs(p.baseCurrencyNotionalValue),
        0,
      );
      const verdict = maintenanceMarginBreached({
        equity: snapshot.netAssetValue,
        grossNotional: gross,
        policy: margin,
      });
      if (!verdict.breached) return;
      if (margin.forcedLiquidation === 'none') {
        warnings.push(
          warning(
            WarningCode.BacktestMarginBreach,
            `${FN}: at ${asOf} the equity ${snapshot.netAssetValue} is below the maintenance requirement ${verdict.requiredEquity} (shortfall ${verdict.shortfall}); forcedLiquidation is 'none', so nothing was closed.`,
            'warn',
            { asOf, shortfall: verdict.shortfall },
          ),
        );
        return;
      }
      const positions = snapshot.positions.filter((p) => p.quantity !== 0);
      if (positions.length === 0) return;
      const targets: Array<{ instrumentId: string; quantity: number }> = [];
      if (margin.forcedLiquidation === 'close-largest-loss') {
        const worst = [...positions].sort(
          (a, b) => a.baseCurrencyUnrealizedPnl - b.baseCurrencyUnrealizedPnl,
        )[0]!;
        targets.push({ instrumentId: worst.instrumentId, quantity: Math.abs(worst.quantity) });
      } else {
        const fraction = Math.min(1, verdict.shortfall / Math.max(gross, 1e-12));
        for (const p of positions)
          targets.push({ instrumentId: p.instrumentId, quantity: Math.abs(p.quantity) * fraction });
      }
      for (const target of targets) {
        if (!(target.quantity > 0)) continue;
        const held = heldQuantity(target.instrumentId);
        orderSequence += 1;
        const order: OrderIntent = {
          orderId: `${runId}:liq${orderSequence}`,
          instrumentId: target.instrumentId,
          side: held > 0 ? 'sell' : 'buy',
          quantity: target.quantity,
          type: 'market',
          submittedTimestampMs: asOf,
        };
        const fill = execute(order, asOf, 'liquidation');
        liquidations.push({
          asOf,
          policy: margin.forcedLiquidation as 'close-largest-loss' | 'pro-rata',
          instrumentId: target.instrumentId,
          quantity: fill?.quantity ?? 0,
          shortfall: verdict.shortfall,
          code: WarningCode.BacktestForcedLiquidation,
        });
        warnings.push(
          warning(
            WarningCode.BacktestForcedLiquidation,
            `${FN}: at ${asOf} a maintenance shortfall of ${verdict.shortfall} forced ${order.side} ${target.quantity} ${target.instrumentId} (${margin.forcedLiquidation}).`,
            'warn',
            { asOf, instrumentId: target.instrumentId, shortfall: verdict.shortfall },
          ),
        );
      }
    }
  };

  // ---- the loop: open (lifecycle, flows, the context) and close (orders, margin, the mark) -----------
  let initialCapital = 0;
  if (instants.length > 0) {
    const opening = accounting.initialCash.map((cash) =>
      envelope(instants[0]!, {
        eventType: 'cash.deposit',
        amount: cash.amount,
        currency: cash.currency,
      }),
    );
    fold(opening);
    // Opening foreign cash is capital, not a first-observation gain. Convert it with the same
    // dated quotes the ledger uses for every subsequent valuation, before external flows.
    initialCapital = navAt(instants[0]!);
  }
  let flowCursor = 0;
  let previous: EpochMs | null = null;
  const stepStart = { orders: 0, fills: 0, rejections: 0, liquidations: 0, events: 0, warnings: 0 };
  const open = (index: number): SessionContext => {
    const asOf = instants[index]!;
    stepStart.orders = orders.length;
    stepStart.fills = fills.length;
    stepStart.rejections = rejections.length;
    stepStart.liquidations = liquidations.length;
    stepStart.events = events.length;
    stepStart.warnings = warnings.length;
    stamp(asOf);
    markCache.clear();
    runLifecycle(previous, asOf, index === instants.length - 1, 'open');
    while (flowCursor < externalFlows.length && externalFlows[flowCursor]!.timestampMs <= asOf) {
      const flow = externalFlows[flowCursor]!;
      flowCursor += 1;
      if (previous !== null && flow.timestampMs <= previous) continue;
      externalFlowCount += 1;
      fold([
        envelope(
          asOf,
          flow.amount > 0
            ? { eventType: 'cash.deposit', amount: flow.amount, currency: flow.currency }
            : { eventType: 'cash.withdrawal', amount: -flow.amount, currency: flow.currency },
        ),
      ]);
    }
    return sessionContext(asOf, index, openingMarkOf);
  };
  const close = (index: number, stepOrders: readonly OrderIntent[]): PortfolioStepFrame => {
    const asOf = instants[index]!;
    for (const order of stepOrders) execute(order, asOf, 'strategy');
    runLifecycle(previous, asOf, index === instants.length - 1, 'close');
    marginCheck(asOf);
    const nav = navAt(asOf);
    const market = marketAt(asOf);
    const conversions = conversionsAt(asOf, heldCurrencies());
    const valuationDate = nextCalendarDate(dateOf(asOf));
    const mark: PortfolioValuationMark = {
      valuationDate,
      market: createMarketSnapshot({
        asOf: isoDateToEpochMs(valuationDate),
        observations: market.observations,
      }),
      ...(conversions.length > 0 ? { currencyConversions: conversions } : {}),
    };
    const last = marks[marks.length - 1];
    if (last !== undefined && last.valuationDate === valuationDate) {
      marks[marks.length - 1] = mark;
      markEquity[markEquity.length - 1] = nav;
    } else {
      marks.push(mark);
      markEquity.push(nav);
    }
    navSeries.push(nav);
    timestamps.push(asOf);
    for (const id of Object.keys(instruments)) {
      const mark = markOf(id, asOf);
      if (mark !== null) completedMarks.set(id, mark.pricePerUnit);
    }
    previous = asOf;
    return {
      asOf,
      index,
      netAssetValue: nav,
      orders: orders.slice(stepStart.orders),
      fills: fills.slice(stepStart.fills),
      rejections: rejections.slice(stepStart.rejections),
      liquidations: liquidations.slice(stepStart.liquidations),
      events: events.slice(stepStart.events),
      warnings: warnings.slice(stepStart.warnings),
    };
  };

  // ---- the ledger's own reports ---------------------------------------------------------------------
  const finish = (): PortfolioBacktestResult => {
    const ledger = createPortfolioLedger({ portfolioId: runId, baseCurrency, lotRelief, events });
    let timeline: PortfolioTimelineResult | null = null;
    let pnl: PortfolioPnlResult | null = null;
    if (marks.length >= 2) {
      timeline = portfolioTimeline({
        ledger,
        valuationMarks: marks,
        instrumentClassification: classifications,
      });
      timeline.rows.forEach((row, i) => {
        const residual = row.netAssetValue - markEquity[i]!;
        if (Math.abs(residual) > Math.abs(reconciliationResidual))
          reconciliationResidual = residual;
      });
      if (!(Math.abs(reconciliationResidual) <= RECONCILIATION_TOLERANCE)) {
        throw new InputError(
          `${FN}: the timeline's net asset value differs from the recorded equity by ${reconciliationResidual} at a mark — an engine invariant failed; nothing was published.`,
          {
            code: ErrorCode.BacktestLedgerReconciliationFailed,
            context: { function: FN, residual: reconciliationResidual },
          },
        );
      }
      pnl = portfolioPnl({
        ledger,
        from: marks[0]!,
        to: marks[marks.length - 1]!,
        instrumentClassification: classifications,
      });
    }
    const equityCurve = [initialCapital, ...navSeries];
    const points: EquityPoint[] = toEquityPoints(equityCurve, timestamps);
    const returns = equityToReturns(equityCurve);
    const performance = analyze({ equity: equityCurve }, { periodsPerYear });

    return {
      ledger: ledger.toJSON(),
      timeline,
      pnl,
      orders,
      fills,
      rejections,
      liquidations,
      events,
      valuationMarks: marks,
      points,
      returns,
      performance,
      finalValue: equityCurve[equityCurve.length - 1]!,
      runId,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        baseCurrency,
        lotRelief,
        settlement: Object.fromEntries(
          Object.keys(instruments).map((id) => [
            id,
            `T+${settlementLag(id)}` as 'T+0' | 'T+1' | 'T+2',
          ]),
        ),
        calendar: request.calendar ?? null,
        sessionConvention:
          'observation timestamps ascend; a calendar keeps business days only; each instant folds pre-open corporate entitlements, bond cash facts and external flows, executes prior-observation decisions, then settles close-derived derivative lifecycle (including same-observation acquisitions), checks margin, and records valuation; open contexts use opening or explicitly carried last-completed marks; the strategy sees the completed observation and post-settlement ledger, and its orders first execute on a later observation; the final instant accepts prior decisions but produces no new decision; forced liquidations use the contemporaneous close, never the earlier open; entry buying power includes dirty prices, fees, existing exposure, and unsettled payables (unsettled receivables are not spendable in a cash account)',
        markConvention:
          'the ledger marks once per UTC calendar date at the following midnight (the mark law: events strictly before the mark instant), from each adapter at the last instant of the date',
        strategy:
          strategy === null
            ? { kind: 'external', replayable: false }
            : 'model' in strategy
              ? {
                  kind: 'model',
                  modelId: isModelPortfolio(strategy.model) ? strategy.model.modelId : null,
                  targets: isModelPortfolio(strategy.model)
                    ? strategy.model.strategic.targets.length
                    : (strategy.model as readonly AllocationTarget[]).length,
                  frequency: strategy.schedule.frequency,
                  scope: strategy.scope ?? 'to-target',
                }
              : { kind: 'callback', replayable: false },
        execution: describeExecutionPolicy(policy),
        instruments: Object.entries(instruments).map(([instrumentId, spec]) => ({
          instrumentId,
          kind: spec.kind,
          adapter: {
            kind: adapters.get(instrumentId)!.kind,
            version: adapters.get(instrumentId)!.version,
          },
          currency: spec.currency,
        })),
        periodsPerYear,
        seed: request.seed ?? null,
        window: { fromTimestampMs: from, toTimestampMs: to },
        ledger: { sourceId, accountId: ACCOUNT_ID },
        replayable,
      },
      diagnostics: {
        engine: 'portfolio-backtest',
        method: 'ledger-fold',
        converged: true,
        warnings,
        sessionCount: timestamps.length,
        orderCount: orders.length,
        fillCount: fills.length,
        rejectionCount: rejections.length,
        liquidationCount: liquidations.length,
        lifecycleEventCount,
        externalFlowCount,
        markCount: marks.length,
        reconciliationResidual,
      },
    };
  };

  const context = (index: number): SessionContext => sessionContext(instants[index]!, index);

  return { instants, runId, open, close, context, valuation, finish, strategyOrders };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export { dateOf as portfolioDateOf, CALENDARS as PORTFOLIO_CALENDAR_TABLE };
export type { CorporateAction };
