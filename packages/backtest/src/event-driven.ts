/**
 * Event-driven execution backtest engine (spec §16.2).
 *
 * A chronological event loop over multi-symbol bars. A `strategy(context)` registers per-symbol bar
 * handlers and streaming indicators; on each bar the engine fills the previous bar's orders, updates
 * indicators, then runs the handler — which may submit new orders that fill on the *next* bar. This
 * one-bar lag is the no-look-ahead contract: a strategy never trades on a price it has already seen.
 *
 *   backtest.eventDriven({ data, broker: brokers.simulated({ cash: 1e5 }), strategy(context) {
 *     const fast = context.indicator('AAPL', technicalAnalysis.sma.stream({ period: 20 }), 'close');
 *     const slow = context.indicator('AAPL', technicalAnalysis.sma.stream({ period: 50 }), 'close');
 *     context.onBar('AAPL', () => {
 *       if (crossOver(fast, slow)) context.buy('AAPL', { percent: 1 });
 *       if (crossUnder(fast, slow)) context.close('AAPL');
 *     });
 *   }});
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  type EpochMs,
  InputError,
  type SymbolId,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  missingFieldError,
  requireArgumentObject,
  sideOf,
  signOf,
  type OrderType,
  type TimeInForce,
  WarningCode,
} from '@totalfinance/core';
import { analyze } from '@totalfinance/performance';
import {
  type BrokerConfig,
  type CorporateAction,
  type OptionContractSpecification,
  SimulatedBroker,
} from './broker.js';
import { equityToReturns } from './vectorized.js';
import { checkDataAlignment } from './diagnostics.js';
import { requireBarData } from './validate.js';
import {
  BENCHMARK_FIXTURE_VERSION,
  type Bar,
  type BacktestAssumptions,
  type BacktestResult,
  type ImplementationRisk,
  type Position,
  toEquityPoints,
  tradeNotional,
} from './types.js';

/** A minimal streaming indicator (structurally compatible with `@insiderfinance/totalfinance/technical-analysis` streams). */
export interface Indicator<In, Out> {
  next(input: In): Out | null;
}

/** A live indicator value the engine refreshes each bar, exposing the current and previous reading. */
export interface IndicatorHandle<Out> {
  value: Out | null;
  previous: Out | null;
}

function requireNumericHandle(
  functionName: string,
  field: string,
  handle: IndicatorHandle<number>,
): void {
  requireArgumentObject(functionName, field, handle);
  for (const key of ['value', 'previous'] as const) {
    const value = handle[key];
    if (value === undefined) {
      throw missingFieldError(
        functionName,
        `${field}.${key}`,
        `${functionName}({ value: 2, previous: 1 }, { value: 1, previous: 1 })`,
      );
    }
    if (value !== null) ensureFinite(value, `${field}.${key}`, functionName);
  }
}

/** Field of a bar to feed an indicator, or a custom extractor. */
export type BarField = 'open' | 'high' | 'low' | 'close' | 'volume';

/** Sizing + order parameters for `context.buy` / `context.sell`. */
export interface TradeOptions {
  /** Incremental share quantity. */
  quantity?: number;
  /** Target allocation as a fraction of equity (a *target*, e.g. `1` = 100% long for `buy`). */
  percent?: number;
  /** Incremental notional value (shares = value / price). */
  value?: number;
  type?: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  takeProfit?: number;
  stopLoss?: number;
}

/** The strategy's view of the world on the current bar. */
export interface StrategyContext {
  /** The bar currently being handled. */
  readonly bar: Bar;
  /**
   * Register a handler that runs on every bar of `symbol`. Throws if `symbol` already has a handler —
   * one handler per symbol, so behaviour never silently depends on registration order (WS2.8).
   */
  onBar(symbol: SymbolId, handler: () => void): void;
  /**
   * Register a portfolio-level handler that fires ONCE per timestamp, after every symbol's bar handler
   * for that timestamp has run — the right hook for cross-sectional logic (ranking, rebalancing) that
   * must not depend on the input bar order (WS2.8).
   */
  onBars(handler: () => void): void;
  /** Bind a streaming indicator to a symbol; returns a handle refreshed before each handler call. */
  indicator<In, Out>(
    symbol: SymbolId,
    stream: Indicator<In, Out>,
    field: BarField | ((bar: Bar) => In),
  ): IndicatorHandle<Out>;
  /** Buy (target long via `percent`, or add via `quantity`/`value`). Returns the order id. */
  buy(symbol: SymbolId, options?: TradeOptions): string;
  /** Sell / short. Returns the order id. */
  sell(symbol: SymbolId, options?: TradeOptions): string;
  /** Flatten the position in `symbol` with a market order. */
  close(symbol: SymbolId): void;
  /** Cancel a working order. */
  cancel(id: string): void;
  /** Current position in `symbol`. */
  position(symbol: SymbolId): Position;
  /** Register an option symbol (underlying/type/strike/expiry) so it's marked and settled at expiry. */
  registerOption(symbol: SymbolId, specification: OptionContractSpecification): void;
  /**
   * Manually exercise `quantity` contracts of a LONG American option early (WS7.4). Requires the
   * broker's `assignment: 'model'` policy; settles at the current underlier mark.
   */
  exercise(symbol: SymbolId, quantity: number): void;
  /** Current cash. */
  readonly cash: number;
  /** Current portfolio equity (cash + marked positions). */
  readonly equity: number;
}

export interface EventDrivenOptions {
  /** Bars for all symbols (each symbol ascending; the engine sorts the merged stream by `ts`). */
  data: Bar[];
  /** A configured broker, or a config to construct one. */
  broker: SimulatedBroker | BrokerConfig;
  /** The strategy: registers handlers + indicators against the context. */
  strategy: (context: StrategyContext) => void;
  /** Corporate actions keyed `"<symbol>@<ts>"`. */
  corporateActions?: Map<string, CorporateAction>;
  /** Bars per year for annualized metrics (default 252). */
  periodsPerYear?: number;
  /** Annualized risk-free rate (default 0). */
  riskFreeRate?: number;
  /**
   * Whether the symbol universe is `point-in-time` (delisted names included) or `current`
   * (survivorship-biased). Recorded in diagnostics; default `point-in-time`.
   */
  universe?: 'point-in-time' | 'current';
}

/** True when series `a` crosses from at-or-below `b` to above it on the latest bar. */
export function crossOver(
  first: IndicatorHandle<number>,
  second: IndicatorHandle<number>,
): boolean {
  requireNumericHandle('crossOver', 'first', first);
  requireNumericHandle('crossOver', 'second', second);
  return (
    first.previous !== null &&
    second.previous !== null &&
    first.value !== null &&
    second.value !== null &&
    first.previous <= second.previous &&
    first.value > second.value
  );
}

/** True when series `a` crosses from at-or-above `b` to below it on the latest bar. */
export function crossUnder(
  first: IndicatorHandle<number>,
  second: IndicatorHandle<number>,
): boolean {
  requireNumericHandle('crossUnder', 'first', first);
  requireNumericHandle('crossUnder', 'second', second);
  return (
    first.previous !== null &&
    second.previous !== null &&
    first.value !== null &&
    second.value !== null &&
    first.previous >= second.previous &&
    first.value < second.value
  );
}

interface BoundIndicator {
  symbol: SymbolId;
  stream: Indicator<unknown, unknown>;
  extract: (bar: Bar) => unknown;
  handle: IndicatorHandle<unknown>;
}

/** EXACT {@link EventDrivenOptions} fields (Law 12) — unknown keys are rejected, never ignored. */
const EVENT_DRIVEN_KEYS = [
  'data',
  'broker',
  'strategy',
  'corporateActions',
  'periodsPerYear',
  'riskFreeRate',
  'universe',
] as const;

/** Run an event-driven backtest. */
export function eventDriven(options: EventDrivenOptions): BacktestResult {
  const functionName = 'eventDriven';
  requireBarData(options, functionName, '{ data: Bar[], strategy, broker, periodsPerYear?, … }');
  ensureKnownKeys(functionName, 'options', options, EVENT_DRIVEN_KEYS);
  // Guard the function/object options at the boundary: a missing `strategy` used to surface as a raw
  // "options.strategy is not a function" TypeError, and a missing `broker` as a property-read crash
  // inside the SimulatedBroker constructor. Teach the field and a minimal working call instead (dx §1.1).
  if (typeof options.strategy !== 'function') {
    throw missingFieldError(
      functionName,
      'strategy',
      "eventDriven({ data, broker: brokers.simulated({ cash: 100_000 }), strategy(context) { context.onBar('SPY', () => context.buy('SPY')) } })",
    );
  }
  if (options.broker === null || typeof options.broker !== 'object') {
    throw missingFieldError(
      functionName,
      'broker',
      'eventDriven({ data, broker: brokers.simulated({ cash: 100_000 }), strategy })',
    );
  }
  // These two ran AFTER the simulation loop for one release: `corporateActions: 42` crashed
  // mid-loop with a raw `.get is not a function` while the teaching guard waited at the tail.
  // Validation happens before the first bar, like every other option here.
  if (options.corporateActions !== undefined && !(options.corporateActions instanceof Map)) {
    throw new InputError(
      `eventDriven: corporateActions must be a Map keyed \`symbol@timestampMs\` when provided. Received ${options.corporateActions === null ? 'null' : typeof options.corporateActions}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'corporateActions' } },
    );
  }
  if (
    options.universe !== undefined &&
    options.universe !== 'point-in-time' &&
    options.universe !== 'current'
  ) {
    throw new InputError(
      `eventDriven: universe must be 'point-in-time' | 'current' when provided. Received ${options.universe === null ? 'null' : JSON.stringify(options.universe)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'universe' } },
    );
  }
  if (options.data.length < 2) {
    throw new InputError(`${functionName}: need ≥ 2 bars, got ${options.data.length}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { bars: options.data.length },
    });
  }
  const broker =
    options.broker instanceof SimulatedBroker
      ? options.broker
      : new SimulatedBroker(options.broker);
  if (
    (options as unknown as Record<string, unknown>)['periodsPerYear'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['periodsPerYear'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['periodsPerYear'] as number))
  ) {
    throw new InputError(
      `eventDriven: periodsPerYear must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['periodsPerYear'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['periodsPerYear']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'periodsPerYear' } },
    );
  }
  const periodsPerYear = options.periodsPerYear ?? 252;
  const initialEquity = broker.cash;

  const handlers = new Map<SymbolId, () => void>();
  const barsHandlers: Array<() => void> = [];
  const indicators: BoundIndicator[] = [];
  const marks = new Map<SymbolId, number>();
  let currentBar: Bar | null = null;

  const fieldExtractor = <In>(field: BarField | ((bar: Bar) => In)): ((bar: Bar) => In) =>
    typeof field === 'function' ? field : (bar: Bar) => bar[field] as In;

  const submitSized = (symbol: SymbolId, side: 'buy' | 'sell', opts2: TradeOptions): string => {
    const extras = {
      ...(opts2.type !== undefined ? { type: opts2.type } : {}),
      ...(opts2.limitPrice !== undefined ? { limitPrice: opts2.limitPrice } : {}),
      ...(opts2.stopPrice !== undefined ? { stopPrice: opts2.stopPrice } : {}),
      ...(opts2.timeInForce !== undefined ? { timeInForce: opts2.timeInForce } : {}),
      ...(opts2.takeProfit !== undefined ? { takeProfit: opts2.takeProfit } : {}),
      ...(opts2.stopLoss !== undefined ? { stopLoss: opts2.stopLoss } : {}),
    };
    // Explicit share count (must be a positive finite number — never silently no-op or reverse).
    if (opts2.quantity !== undefined) {
      ensurePositive(opts2.quantity, 'quantity', `${functionName}.${side}`);
      return broker.submit({ symbol, side, quantity: opts2.quantity, ...extras });
    }
    // Incremental notional (sized to shares at fill).
    if (opts2.value !== undefined) {
      ensurePositive(opts2.value, 'value', `${functionName}.${side}`);
      return broker.submit({ symbol, side, notional: opts2.value, ...extras });
    }
    // Target allocation: trade the cash delta to reach `percent`·equity exposure (signed by side).
    if (opts2.percent !== undefined) {
      if (!(opts2.percent >= 0) || !Number.isFinite(opts2.percent)) {
        // A negative percent would silently reverse direction (a `buy` becoming a short); reject it.
        throw new InputError(
          `${functionName}.${side}: percent must be a finite number ≥ 0, got ${opts2.percent}.`,
          { code: ErrorCode.InputOutOfRange, context: { percent: opts2.percent } },
        );
      }
      // Price the SIZED symbol with ITS OWN latest mark, never `currentBar`. Inside `context.onBars`
      // (and inside any symbol's handler that trades a DIFFERENT symbol) `currentBar` is whichever
      // symbol's bar the engine happened to process last, so valuing the held position at
      // `currentBar.close` marked symbol A at symbol B's price — a silent mis-size that grew with the
      // price gap between the two names. `marks` is the engine's per-symbol mark map (the same one
      // `broker.equity` values the book with), so the target and the current value are now quoted in
      // one consistent set of prices. Inside `onBar(symbol)` this is identical to the old behaviour:
      // the engine writes `marks[symbol] = bar.close` immediately before calling that handler.
      const position = broker.position(symbol);
      const mark = marks.get(symbol);
      if (mark === undefined && Math.abs(position.quantity) > 1e-12) {
        // A held position with no mark cannot be valued — sizing off another symbol's price is
        // exactly the defect above, so refuse rather than fabricate a target.
        throw new InputError(
          `${functionName}.${side}: cannot size '${symbol}' by percent — no bar has priced it yet, but a position of ${position.quantity} is open.`,
          { code: ErrorCode.InputMissingField, context: { symbol, quantity: position.quantity } },
        );
      }
      const price = mark ?? currentBar!.close;
      const targetValue = signOf(side) * opts2.percent * broker.equity(marks);
      const currentValue = position.quantity * price;
      const delta = targetValue - currentValue;
      if (Math.abs(delta) < 1e-9) return '';
      return broker.submit({
        symbol,
        side: sideOf(delta),
        notional: Math.abs(delta),
        ...extras,
      });
    }
    throw new InputError(
      `${functionName}: context.${side} requires one of quantity, value, or percent.`,
      {
        code: ErrorCode.InputMissingField,
        context: { symbol },
      },
    );
  };

  const context: StrategyContext = {
    get bar() {
      return currentBar!;
    },
    onBar(symbol, handler) {
      if (handlers.has(symbol)) {
        throw new InputError(
          `${functionName}: onBar('${symbol}') was already registered — one handler per symbol (register cross-sectional logic via context.onBars).`,
          { code: ErrorCode.BacktestDuplicateHandler, context: { symbol } },
        );
      }
      handlers.set(symbol, handler);
    },
    onBars(handler) {
      barsHandlers.push(handler);
    },
    indicator(symbol, stream, field) {
      const handle: IndicatorHandle<unknown> = { value: null, previous: null };
      indicators.push({
        symbol,
        stream: stream as Indicator<unknown, unknown>,
        extract: fieldExtractor(field) as (bar: Bar) => unknown,
        handle,
      });
      return handle as IndicatorHandle<never>;
    },
    buy(symbol, opts2 = { percent: 1 }) {
      return submitSized(symbol, 'buy', opts2);
    },
    sell(symbol, opts2 = { percent: 1 }) {
      return submitSized(symbol, 'sell', opts2);
    },
    close(symbol) {
      const pos = broker.position(symbol);
      if (Math.abs(pos.quantity) > 1e-12) {
        broker.submit({
          symbol,
          side: sideOf(-pos.quantity), // flatten: the opposite of the held sign
          quantity: Math.abs(pos.quantity),
        });
      }
    },
    cancel(id) {
      broker.cancel(id);
    },
    position(symbol) {
      return broker.position(symbol);
    },
    registerOption(symbol, specification) {
      broker.registerOption(symbol, specification);
    },
    exercise(symbol, quantity) {
      broker.exerciseOption({
        symbol,
        quantity,
        timestampMs: currentBar!.timestampMs,
        underlierMarks: marks,
      });
    },
    get cash() {
      return broker.cash;
    },
    get equity() {
      return broker.equity(marks);
    },
  };

  options.strategy(context);

  // Chronological merge (stable on ties, preserving each symbol's input order).
  const sorted = options.data
    .map((b, i) => ({ b, i }))
    .sort((x, y) => x.b.timestampMs - y.b.timestampMs || x.i - y.i);

  const equityCurve: number[] = [initialEquity];
  const timestamps: EpochMs[] = [];
  let curTs: EpochMs | null = null;

  const fireOnBars = (): void => {
    for (const h of barsHandlers) h();
  };

  for (const { b } of sorted) {
    if (curTs !== null && b.timestampMs !== curTs) {
      // The just-completed timestamp's per-symbol handlers have all run — fire the portfolio-level
      // onBars hooks once, then settle any options expiring at that timestamp (using its marks).
      fireOnBars();
      broker.settleExpiries(curTs, marks);
      equityCurve.push(broker.equity(marks));
      timestamps.push(curTs);
    }
    curTs = b.timestampMs;
    const action = options.corporateActions?.get(`${b.symbol}@${b.timestampMs}`);
    broker.processBar(b, action);
    marks.set(b.symbol, b.close);
    currentBar = b;
    for (const ind of indicators) {
      if (ind.symbol === b.symbol) {
        ind.handle.previous = ind.handle.value;
        ind.handle.value = ind.stream.next(ind.extract(b));
      }
    }
    handlers.get(b.symbol)?.();
  }
  if (curTs !== null) {
    fireOnBars(); // portfolio-level hooks for the final timestamp
    broker.settleExpiries(curTs, marks); // settle anything expiring at the final timestamp
    equityCurve.push(broker.equity(marks));
    timestamps.push(curTs);
  }

  const universe = options.universe ?? 'point-in-time';
  const warnings = [...checkDataAlignment(options.data), ...broker.warnings];
  if (universe === 'current') {
    warnings.push({
      code: WarningCode.ResearchSurvivorshipBias,
      message:
        'Universe is `current` (delisted names excluded); results are likely survivorship-biased.',
      severity: 'warn',
      context: { universe },
    });
  }

  // Turnover is a CASH ratio, so each fill must be valued at its contract multiplier: a registered
  // option trades 100 underlier shares per contract, and omitting that reported an option book's
  // turnover at 1% of its true size.
  const tradedNotional = broker.trades.reduce((s, t) => s + tradeNotional(t), 0);
  const averageEquity = equityCurve.reduce((s, e) => s + e, 0) / equityCurve.length;
  const brokerPolicies = broker.policies();

  const assumptions: BacktestAssumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    initialCapital: initialEquity,
    fill: 'next-bar-open / intrabar-trigger',
    cost: brokerPolicies.cost,
    slippage: brokerPolicies.slippage,
    cashSettlement: 'immediate',
    corporateAction: options.corporateActions ? 'dividends-and-splits' : 'none',
    calendar: 'event-driven',
    margin: brokerPolicies.margin,
    assignment: brokerPolicies.assignment,
    oco: brokerPolicies.oco,
  };
  const diagnostics: ImplementationRisk = {
    warnings,
    benchmarkFixtureVersion: BENCHMARK_FIXTURE_VERSION,
  };

  return {
    points: toEquityPoints(equityCurve, timestamps),
    returns: equityToReturns(equityCurve),
    // Snapshot, not the live broker array: the result must stay stable if the broker is reused.
    trades: [...broker.trades],
    finalValue: equityCurve[equityCurve.length - 1]!,
    turnover: averageEquity > 0 ? tradedNotional / averageEquity : 0,
    performance: analyze(
      { equity: equityCurve },
      {
        periodsPerYear,
        ...(options.riskFreeRate !== undefined ? { riskFreeRate: options.riskFreeRate } : {}),
      },
    ),
    assumptions,
    diagnostics,
    ...(broker.settlements.length > 0 ? { settlements: [...broker.settlements] } : {}),
  };
}
