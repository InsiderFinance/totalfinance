/**
 * Simulated broker for the event-driven engine (spec §16.2).
 *
 * Holds a cash + positions account and fills orders against incoming bars with realistic mechanics:
 * market / limit / stop / stop-limit order types, OCO and bracket links, shorting with borrow fees,
 * a gross-leverage (margin) cap, commission + slippage, optional volume-participation partial fills,
 * and dividend / split corporate actions. Deterministic — no clock, no randomness.
 *
 * The no-look-ahead contract is enforced by the engine: a strategy submits orders while handling bar
 * `i`; `processBar` fills them against bar `i+1` (market orders at its open, stops/limits intrabar).
 */

import {
  ErrorCode,
  type EpochMs,
  InputError,
  type QuantWarning,
  type SymbolId,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  ORDER_TYPES,
  TIME_IN_FORCE_VALUES,
  signOf,
  type OrderSide,
  type OrderType,
  type TimeInForce,
  WarningCode,
} from '@totalfinance/core';
import {
  type BorrowModel,
  type CostModel,
  type SlippageModel,
  borrow as borrowNs,
  fees as feesNs,
  slippage as slipNs,
} from './costs.js';
import type {
  Bar,
  OptionContractSpecification,
  OptionSettlement,
  Position,
  Trade,
} from './types.js';

/** Kebab-case like every other enum on the surface (B6). */
export type OrderStatus = 'pending' | 'partially-filled' | 'filled' | 'cancelled';

/**
 * Reject impossible bars before they reach the fill logic, which reads `open`/`high`/`low` — a
 * negative or non-finite price (or `low > min(open,close)` / `high < max(open,close)`) would otherwise
 * produce a fabricated fill. Backtests must fail loudly on impossible inputs (design law #4).
 */
function validateBar(bar: Bar, functionName: string): void {
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    const v = bar[field];
    if (!(v > 0) || !Number.isFinite(v)) {
      throw new InputError(
        `${functionName}: bar ${field} must be a positive finite number, got ${v} (${bar.symbol}@${bar.timestampMs}).`,
        {
          code: ErrorCode.InputNegativeSpot,
          context: { symbol: bar.symbol, timestampMs: bar.timestampMs, field, value: v },
        },
      );
    }
  }
  const lo = Math.min(bar.open, bar.close);
  const hi = Math.max(bar.open, bar.close);
  if (bar.low > lo + 1e-9 || bar.high < hi - 1e-9 || bar.low > bar.high) {
    throw new InputError(
      `${functionName}: bar OHLC is inconsistent (need low ≤ min(open,close) and high ≥ max(open,close)) for ${bar.symbol}@${bar.timestampMs}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
      },
    );
  }
}

/** A request to trade, passed to {@link SimulatedBroker.submit}. Provide `quantity` *or* `notional`. */
export interface OrderRequest {
  symbol: SymbolId;
  side: OrderSide;
  /** Share quantity to trade (> 0). Mutually exclusive with `notional`. */
  quantity?: number;
  /** Cash notional to trade; the broker sizes shares at the fill price. Mutually exclusive with `quantity`. */
  notional?: number;
  /** Order type (default `market`). */
  type?: OrderType;
  /** Limit price (for `limit` / `stop-limit`). */
  limitPrice?: number;
  /** Stop trigger price (for `stop` / `stop-limit`). */
  stopPrice?: number;
  /** Time in force (default `gtc`). */
  timeInForce?: TimeInForce;
  /** Bracket: a take-profit **limit** price, attached as an OCO child once the parent fills. */
  takeProfit?: number;
  /** Bracket: a stop-loss **stop** price, attached as an OCO child once the parent fills. */
  stopLoss?: number;
  /** OCO group: filling or cancelling any member cancels the rest. */
  ocoGroup?: string;
}

/** A live order tracked by the broker. */
export interface Order {
  id: string;
  symbol: SymbolId;
  side: OrderSide;
  type: OrderType;
  /** Target share quantity (0 for notional orders, where shares are sized at fill). */
  quantity: number;
  /** Target cash notional, when the order is notional-sized. */
  notional?: number;
  filledQuantity: number;
  /** Cash notional filled so far (notional orders). */
  filledNotional: number;
  status: OrderStatus;
  timeInForce: TimeInForce;
  limitPrice?: number;
  stopPrice?: number;
  ocoGroup?: string;
  takeProfit?: number;
  stopLoss?: number;
  /**
   * Timestamp of the bar the broker was processing when the order was submitted — an order placed in
   * a strategy's bar handler carries that bar's `ts`. Absent when the order was submitted before the
   * broker had seen any bar (the sim broker has no clock of its own).
   */
  submittedTimestampMs?: EpochMs;
}

/** A corporate action effective on a bar. */
export interface CorporateAction {
  /** Cash dividend per share (long receives, short pays). */
  dividend?: number;
  /** Split ratio `R` (`2` = 2-for-1: quantities ×R, prices ÷R). */
  split?: number;
}

export type {
  OptionContractSpecification,
  OptionSettlement,
  OptionSettlementStyle,
} from './types.js';

export interface BrokerConfig {
  /** Opening cash. */
  cash: number;
  commission?: CostModel;
  slippage?: SlippageModel;
  borrow?: BorrowModel;
  /** Bars per year, for borrow accrual (default 252). */
  periodsPerYear?: number;
  /** Max gross leverage `Σ|positionNotional| / equity` allowed at fill (default `Infinity`). */
  maxLeverage?: number;
  /** Disallow short positions (default `false`). */
  noShort?: boolean;
  /** Cap a single bar's fill to this fraction of bar volume (partial fills); default `Infinity`. */
  maxVolumeParticipation?: number;
  /**
   * American early exercise/assignment policy (WS7.4). `'none'` (default) settles options only at
   * expiry — every European-style golden is byte-identical. `'model'` options in to modeling early
   * assignment of American short options at ex-dividend dates (short calls) and deep-ITM thresholds
   * (short puts), plus manual `exerciseOption`/`context.exercise` for American longs.
   */
  assignment?: 'model' | 'none';
  /**
   * Short-put early-assignment buffer as a FRACTION of strike (default `0.02`): a short put is
   * assigned early when the interest CARRY benefit of exercising now exceeds the remaining extrinsic
   * (time value) by more than `threshold·strike`. Only used when `assignment: 'model'`.
   */
  assignmentThreshold?: number;
  /**
   * Continuously-compounded risk-free rate (decimal, default `0`) used ONLY for the short-put
   * early-assignment carry economics — early put exercise is driven by the interest earned on the
   * strike over the option's remaining life. With rate `0` there is no carry incentive, so a short
   * put is never assigned early on arbitrage-free prices. Only used when `assignment: 'model'`.
   */
  riskFreeRate?: number;
}

export interface ExerciseOptionInput {
  symbol: SymbolId;
  quantity: number;
  timestampMs: EpochMs;
  underlierMarks?: Map<SymbolId, number>;
}

/** Broker factory (spec §16.2: `brokers.simulated({ cash, commission, slippage })`). */
export const brokers = {
  /** Construct a simulated broker. */
  simulated(config: BrokerConfig): SimulatedBroker {
    requireArgumentObject('brokers.simulated', 'config', config);
    return new SimulatedBroker(config);
  },
} as const;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `o${counter}`;
}

/** A deterministic simulated broker. */
export class SimulatedBroker {
  cash: number;
  readonly positions = new Map<SymbolId, Position>();
  private readonly _orders: Order[] = [];
  private readonly _trades: Trade[] = [];
  private readonly _warnings: QuantWarning[] = [];
  private readonly _settlements: OptionSettlement[] = [];

  // The broker is LIVE simulator state: the engine appends to these arrays as the simulation runs,
  // so they are exposed as readonly live views (not frozen snapshots — dx §4.4). Callers observing
  // mid-run see growth; callers must never mutate (the readonly types enforce this in TS).
  /** All orders ever submitted (live view, readonly). */
  get orders(): readonly Order[] {
    return this._orders;
  }
  /** All fills (live view, readonly). */
  get trades(): readonly Trade[] {
    return this._trades;
  }
  /** Structured warnings raised during simulation (live view, readonly). */
  get warnings(): readonly QuantWarning[] {
    return this._warnings;
  }
  /** Option positions settled at expiry — exercise / assignment / worthless (live view, readonly). */
  get settlements(): readonly OptionSettlement[] {
    return this._settlements;
  }
  private readonly optionSpecs = new Map<SymbolId, Required<OptionContractSpecification>>();

  private readonly fee: CostModel;
  private readonly slip: SlippageModel;
  private readonly brw: BorrowModel;
  private readonly periodsPerYear: number;
  private readonly maxLeverage: number;
  private readonly noShort: boolean;
  private readonly participation: number;
  private readonly assignmentModel: boolean;
  private readonly assignmentThreshold: number;
  private readonly riskFreeRate: number;
  private readonly lastMark = new Map<SymbolId, number>();
  /** Timestamp of the bar currently/last processed — the broker's only notion of "now". */
  private lastTs: EpochMs | null = null;
  /** Symbols already warned about being marked at cost (averagePrice) — one warning per symbol (WS2.8). */
  private readonly markedAtCost = new Set<SymbolId>();
  private cashLowWater = Infinity;
  private negativeCashWarning: QuantWarning | null = null;

  constructor(config: BrokerConfig) {
    requireArgumentObject('SimulatedBroker', 'config', config);
    // Law 12 + when-present ladders (the 350c2796 ruling): `{ assignment: null }` used to run the
    // 'none' policy silently, and a `comission` typo left the fee model at zero cost.
    ensureKnownKeys('SimulatedBroker', 'config', config, [
      'cash',
      'commission',
      'slippage',
      'borrow',
      'periodsPerYear',
      'maxLeverage',
      'noShort',
      'maxVolumeParticipation',
      'assignment',
      'assignmentThreshold',
      'riskFreeRate',
    ]);
    for (const field of [
      'periodsPerYear',
      'maxLeverage',
      'maxVolumeParticipation',
      'assignmentThreshold',
      'riskFreeRate',
    ] as const) {
      const value = (config as unknown as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new InputError(
          `SimulatedBroker: ${field} must be a finite number when provided. Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field } },
        );
      }
    }
    if (config.noShort !== undefined && typeof config.noShort !== 'boolean') {
      throw new InputError(
        `SimulatedBroker: noShort must be a boolean when provided. Received ${config.noShort === null ? 'null' : typeof config.noShort}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'noShort' } },
      );
    }
    if (
      config.assignment !== undefined &&
      config.assignment !== 'model' &&
      config.assignment !== 'none'
    ) {
      throw new InputError(
        `SimulatedBroker: assignment must be 'model' | 'none' when provided. Received ${config.assignment === null ? 'null' : JSON.stringify(config.assignment)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'assignment' } },
      );
    }
    for (const modelField of ['commission', 'slippage', 'borrow'] as const) {
      const value = (config as unknown as Record<string, unknown>)[modelField];
      if (value !== undefined && (value === null || typeof value !== 'object')) {
        throw new InputError(
          `SimulatedBroker: ${modelField} must be a cost-model object when provided — build one with the fees/slippage/borrow namespaces. Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field: modelField } },
        );
      }
    }
    ensureFinite(config.cash, 'cash', 'SimulatedBroker');
    this.cash = config.cash;
    this.fee = config.commission ?? feesNs.none();
    this.slip = config.slippage ?? slipNs.none();
    this.brw = config.borrow ?? borrowNs.none();
    this.periodsPerYear = config.periodsPerYear ?? 252;
    ensurePositive(this.periodsPerYear, 'periodsPerYear', 'SimulatedBroker');
    // maxLeverage / participation default to Infinity (no cap), so allow Infinity but reject ≤ 0 / NaN.
    if (config.maxLeverage !== undefined && !(config.maxLeverage > 0)) {
      throw new InputError(`SimulatedBroker: maxLeverage must be > 0, got ${config.maxLeverage}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { maxLeverage: config.maxLeverage },
      });
    }
    if (config.maxVolumeParticipation !== undefined && !(config.maxVolumeParticipation > 0)) {
      throw new InputError(
        `SimulatedBroker: maxVolumeParticipation must be > 0, got ${config.maxVolumeParticipation}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { maxVolumeParticipation: config.maxVolumeParticipation },
        },
      );
    }
    this.maxLeverage = config.maxLeverage ?? Infinity;
    this.noShort = config.noShort ?? false;
    this.participation = config.maxVolumeParticipation ?? Infinity;
    const assignment = config.assignment ?? 'none';
    if (assignment !== 'model' && assignment !== 'none') {
      throw new InputError(
        `SimulatedBroker: assignment must be 'model' or 'none', got "${assignment}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { assignment },
        },
      );
    }
    this.assignmentModel = assignment === 'model';
    this.riskFreeRate = config.riskFreeRate ?? 0;
    ensureFinite(this.riskFreeRate, 'riskFreeRate', 'SimulatedBroker');
    this.assignmentThreshold = config.assignmentThreshold ?? 0.02;
    if (!(this.assignmentThreshold >= 0)) {
      throw new InputError(
        `SimulatedBroker: assignmentThreshold must be ≥ 0, got ${this.assignmentThreshold}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { assignmentThreshold: this.assignmentThreshold },
        },
      );
    }
  }

  /** The policy labels for the implementation-risk diagnostics. */
  policies(): {
    cost: string;
    slippage: string;
    margin: string;
    assignment: string;
    oco: string;
  } {
    return {
      cost: this.fee.label,
      slippage: this.slip.label,
      // Infinite leverage means fills are never funding-checked — disclose it rather than hide it.
      margin: Number.isFinite(this.maxLeverage) ? 'maxLeverage' : 'unconstrained',
      assignment: this.assignmentModel ? 'model' : 'none',
      // A bar that touches a bracket's take-profit AND its stop-loss is ambiguous — nothing in OHLC
      // says which came first. Orders fill in submission order and `onParentFilled` submits the
      // take-profit first, so the optimistic leg wins. Disclosed, never silent.
      oco: 'take-profit-first-on-ambiguous-bar',
    };
  }

  position(symbol: SymbolId): Position {
    return this.positions.get(symbol) ?? { symbol, quantity: 0, averagePrice: 0 };
  }

  /** Contract multiplier for a symbol (registered option ⇒ its multiplier; a share ⇒ 1). */
  private multiplierOf(symbol: SymbolId): number {
    return this.optionSpecs.get(symbol)?.multiplier ?? 1;
  }

  /** Portfolio equity = cash + Σ position market value at the supplied marks (option positions ×multiplier). */
  equity(marks: Map<SymbolId, number>): number {
    let v = this.cash;
    for (const pos of this.positions.values()) {
      let m = marks.get(pos.symbol) ?? this.lastMark.get(pos.symbol);
      if (m === undefined) {
        // No live mark and no prior mark — value the position at its own cost basis. That is a
        // stand-in, not a market price, so flag it once per symbol rather than pretend it's a mark.
        m = pos.averagePrice;
        if (pos.quantity !== 0 && !this.markedAtCost.has(pos.symbol)) {
          this.markedAtCost.add(pos.symbol);
          this._warnings.push({
            code: WarningCode.BacktestMarkedAtCost,
            message: `Position '${pos.symbol}' has no market mark yet; valued at its average cost (${pos.averagePrice}) until a bar arrives.`,
            severity: 'info',
            context: { symbol: pos.symbol, averagePrice: pos.averagePrice },
          });
        }
      }
      v += pos.quantity * m * this.multiplierOf(pos.symbol);
    }
    return v;
  }

  /**
   * Register an option symbol so the broker marks it by its contract multiplier and settles it at
   * expiry (spec §16.2). Required before trading or settling an option position.
   */
  registerOption(symbol: SymbolId, specification: OptionContractSpecification): void {
    const functionName = 'SimulatedBroker.registerOption';
    if (typeof symbol !== 'string' || symbol.length === 0) {
      throw new InputError(
        `${functionName}: symbol must be a non-empty symbol id. Received ${symbol === null ? 'null' : symbol === undefined ? 'undefined' : typeof symbol}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'symbol' } },
      );
    }
    requireArgumentObject(functionName, 'specification', specification);
    ensureKnownKeys(functionName, 'specification', specification, [
      'underlying',
      'type',
      'strike',
      'expiresAt',
      'multiplier',
      'settlement',
      'style',
    ]);
    if (typeof specification.underlying !== 'string' || specification.underlying.length === 0) {
      throw new InputError(
        `${functionName}: underlying must be a non-empty symbol id (the symbol the option exercises into). Received ${specification.underlying === null ? 'null' : specification.underlying === undefined ? 'undefined' : typeof specification.underlying}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'underlying' } },
      );
    }
    if (
      specification.style !== undefined &&
      specification.style !== 'american' &&
      specification.style !== 'european'
    ) {
      throw new InputError(
        `${functionName}: style must be 'american' | 'european' when provided. Received ${specification.style === null ? 'null' : JSON.stringify(specification.style)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'style' } },
      );
    }
    if (
      specification.multiplier !== undefined &&
      (typeof specification.multiplier !== 'number' || !Number.isFinite(specification.multiplier))
    ) {
      throw new InputError(
        `${functionName}: multiplier must be a finite number when provided. Received ${specification.multiplier === null ? 'null' : typeof specification.multiplier}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'multiplier' } },
      );
    }
    if (
      specification.settlement !== undefined &&
      specification.settlement !== 'physical' &&
      specification.settlement !== 'cash'
    ) {
      throw new InputError(
        `${functionName}: settlement must be 'physical' | 'cash' when provided. Received ${specification.settlement === null ? 'null' : JSON.stringify(specification.settlement)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'settlement' } },
      );
    }
    ensurePositive(specification.strike, 'strike', functionName);
    ensureFinite(specification.expiresAt, 'expiresAt', functionName);
    if (specification.type !== 'call' && specification.type !== 'put') {
      throw new InputError(
        `${functionName}: type must be 'call' or 'put', got "${String(specification.type)}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { type: specification.type },
        },
      );
    }
    const multiplier = specification.multiplier ?? 100;
    ensurePositive(multiplier, 'multiplier', functionName);
    const settlement = specification.settlement ?? 'physical';
    if (settlement !== 'physical' && settlement !== 'cash') {
      throw new InputError(
        `${functionName}: settlement must be 'physical' or 'cash', got "${settlement}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { settlement },
        },
      );
    }
    const style = specification.style ?? 'american';
    if (style !== 'american' && style !== 'european') {
      throw new InputError(
        `${functionName}: style must be 'american' or 'european', got "${style}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { style },
        },
      );
    }
    this.optionSpecs.set(symbol, {
      underlying: specification.underlying,
      type: specification.type,
      strike: specification.strike,
      expiresAt: specification.expiresAt,
      multiplier,
      settlement,
      style,
    });
  }

  /**
   * Settle every registered option whose expiry is at or before `asOfTimestampMs`. ITM long positions are
   * exercised and ITM shorts assigned (physical: the underlier position is adjusted at the strike;
   * cash: the intrinsic is paid/received); OTM positions expire worthless. Returns the new settlements.
   * The underlier settlement price comes from `underlierMarks` or the broker's last seen mark.
   */
  settleExpiries(
    asOfTimestampMs: EpochMs,
    underlierMarks?: Map<SymbolId, number>,
  ): OptionSettlement[] {
    if (typeof asOfTimestampMs !== 'number' || !Number.isFinite(asOfTimestampMs)) {
      throw new InputError(
        `SimulatedBroker.settleExpiries: asOfTimestampMs must be a finite epoch-ms timestamp. Received ${asOfTimestampMs === null ? 'null' : asOfTimestampMs === undefined ? 'undefined' : typeof asOfTimestampMs}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'asOfTimestampMs' } },
      );
    }
    const out: OptionSettlement[] = [];
    for (const [symbol, specification] of [...this.optionSpecs]) {
      if (specification.expiresAt > asOfTimestampMs) continue;
      const contracts = this.positions.get(symbol)?.quantity ?? 0;
      // Resolve and validate the underlier settlement price BEFORE mutating any state: a missing or
      // malformed (NaN / non-positive) mark must throw with the option still registered so the
      // settlement stays retryable, rather than stranding the option or writing a NaN into cash/shares.
      let S: number | undefined;
      if (contracts !== 0) {
        S =
          underlierMarks?.get(specification.underlying) ??
          this.lastMark.get(specification.underlying);
        if (S === undefined || !Number.isFinite(S) || S <= 0) {
          throw new InputError(
            `SimulatedBroker.settleExpiries: no valid settlement price for underlier ${specification.underlying} of ${symbol} (got ${S}).`,
            {
              code: S === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
              context: { underlying: specification.underlying, symbol, settlementPrice: S },
            },
          );
        }
      }
      // The option ceases to exist at expiry: drop its registration and cancel any working orders.
      for (const o of this.orders) {
        if (o.symbol === symbol && (o.status === 'pending' || o.status === 'partially-filled')) {
          o.status = 'cancelled';
        }
      }
      this.optionSpecs.delete(symbol);
      this.lastMark.delete(symbol);
      if (contracts === 0) {
        this.positions.delete(symbol);
        continue;
      }
      const s = S!;
      const intrinsic =
        specification.type === 'call'
          ? Math.max(s - specification.strike, 0)
          : Math.max(specification.strike - s, 0);
      const cashBefore = this.cash;
      this.positions.delete(symbol); // remove the option leg before adjusting the underlier
      let action: OptionSettlement['action'];
      let shares = 0;
      if (intrinsic <= 0) {
        action = 'expired';
      } else {
        action = contracts > 0 ? 'exercised' : 'assigned';
        if (specification.settlement === 'cash') {
          this.cash += intrinsic * specification.multiplier * contracts;
        } else {
          const sharesAbs = specification.multiplier * Math.abs(contracts);
          // Calls deliver shares to the long; puts deliver from the long. Short positions mirror.
          const side: OrderSide =
            specification.type === 'call'
              ? contracts > 0
                ? 'buy'
                : 'sell'
              : contracts > 0
                ? 'sell'
                : 'buy';
          this.applyFill({
            symbol: specification.underlying,
            side,
            quantity: sharesAbs,
            price: specification.strike,
            commission: 0,
          });
          shares = signOf(side) * sharesAbs;
        }
      }
      const settlement: OptionSettlement = {
        symbol,
        underlying: specification.underlying,
        timestampMs: asOfTimestampMs,
        type: specification.type,
        strike: specification.strike,
        multiplier: specification.multiplier,
        contracts,
        underlierPrice: s,
        intrinsic,
        action,
        settlement: specification.settlement,
        cashFlow: this.cash - cashBefore,
        shares,
      };
      this._settlements.push(settlement);
      out.push(settlement);
    }
    return out;
  }

  /**
   * American early exercise/assignment checks for one bar (WS7.4), run before dividends are applied.
   * Two triggers: (a) an ex-dividend on an underlier assigns each American SHORT call on it when
   * `dividend > remaining extrinsic` (dividend-capture early exercise); (b) a bar that prices an
   * American SHORT put assigns it when the interest CARRY benefit of exercising now exceeds the
   * remaining extrinsic (time value) — the economics that actually drive early put exercise.
   */
  private earlyAssignmentsForBar(bar: Bar, action?: CorporateAction): void {
    // (b) Deep-ITM short put — this bar prices the option itself; its close is the mark.
    const ownSpecification = this.optionSpecs.get(bar.symbol);
    if (
      ownSpecification &&
      ownSpecification.style === 'american' &&
      ownSpecification.type === 'put'
    ) {
      const contracts = this.positions.get(bar.symbol)?.quantity ?? 0;
      const under = this.lastMark.get(ownSpecification.underlying);
      if (contracts < 0 && under !== undefined && under > 0) {
        const intrinsic = Math.max(ownSpecification.strike - under, 0);
        // Early put exercise is driven by CARRY: receiving the strike now earns interest over the
        // option's remaining life. Assign when that benefit exceeds the remaining extrinsic (time
        // value = mark − intrinsic) by the buffer. The old `intrinsic − mark > threshold` test was
        // backwards — on arbitrage-free prices an American put's mark is ≥ intrinsic, so it required
        // a sub-intrinsic mark and never fired. (Underlier price is the last mark before this
        // option-bar — a bar-ordering approximation.)
        const extrinsic = Math.max(0, bar.close - intrinsic);
        const tau = Math.max(0, ownSpecification.expiresAt - bar.timestampMs) / (365 * 86_400_000);
        const carryBenefit = ownSpecification.strike * (1 - Math.exp(-this.riskFreeRate * tau));
        if (carryBenefit - extrinsic > this.assignmentThreshold * ownSpecification.strike) {
          this.settleEarly({
            symbol: bar.symbol,
            specification: ownSpecification,
            contracts,
            underlierPrice: under,
            timestampMs: bar.timestampMs,
            reason: 'deep-itm',
          });
        }
      }
    }
    // (a) Ex-dividend short calls — the bar's symbol is an underlier paying a dividend.
    if (action?.dividend && action.dividend > 0) {
      for (const [symbol, specification] of [...this.optionSpecs]) {
        if (
          specification.underlying !== bar.symbol ||
          specification.type !== 'call' ||
          specification.style !== 'american'
        ) {
          continue;
        }
        const contracts = this.positions.get(symbol)?.quantity ?? 0;
        if (contracts >= 0) continue; // only shorts are assigned
        const optionMark = this.lastMark.get(symbol);
        const under = this.lastMark.get(specification.underlying); // the ex-date-eve underlier mark
        if (optionMark === undefined || under === undefined || under <= 0) continue;
        const extrinsic = Math.max(0, optionMark - Math.max(under - specification.strike, 0));
        if (action.dividend > extrinsic) {
          this.settleEarly({
            symbol,
            specification,
            contracts,
            underlierPrice: under,
            timestampMs: bar.timestampMs,
            reason: 'dividend',
          });
        }
      }
    }
  }

  /** Settle `contracts` (signed) of a registered option early: physical/cash, record + warn (WS7.4). */
  private settleEarly(input: {
    symbol: SymbolId;
    specification: Required<OptionContractSpecification>;
    contracts: number;
    underlierPrice: number;
    timestampMs: EpochMs;
    reason: 'dividend' | 'deep-itm' | 'manual';
  }): OptionSettlement {
    const { symbol, specification, contracts, underlierPrice, timestampMs, reason } = input;
    const intrinsic =
      specification.type === 'call'
        ? Math.max(underlierPrice - specification.strike, 0)
        : Math.max(specification.strike - underlierPrice, 0);
    const cashBefore = this.cash;
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.quantity -= contracts;
      if (pos.quantity === 0) this.positions.delete(symbol);
    }
    const action: OptionSettlement['action'] = contracts > 0 ? 'exercised' : 'assigned';
    let shares = 0;
    if (specification.settlement === 'cash') {
      this.cash += intrinsic * specification.multiplier * contracts;
    } else {
      const sharesAbs = specification.multiplier * Math.abs(contracts);
      const side: OrderSide =
        specification.type === 'call'
          ? contracts > 0
            ? 'buy'
            : 'sell'
          : contracts > 0
            ? 'sell'
            : 'buy';
      this.applyFill({
        symbol: specification.underlying,
        side,
        quantity: sharesAbs,
        price: specification.strike,
        commission: 0,
      });
      shares = signOf(side) * sharesAbs;
    }
    const settlement: OptionSettlement = {
      symbol,
      underlying: specification.underlying,
      timestampMs,
      type: specification.type,
      strike: specification.strike,
      multiplier: specification.multiplier,
      contracts,
      underlierPrice,
      intrinsic,
      action,
      settlement: specification.settlement,
      cashFlow: this.cash - cashBefore,
      shares,
      early: true,
      reason,
    };
    this._settlements.push(settlement);
    this._warnings.push({
      code: WarningCode.BacktestAssignment,
      message: `American ${
        specification.type
      } ${symbol} ${action} early (${reason}) at underlier ${underlierPrice}: ${Math.abs(
        contracts,
      )} contract(s).`,
      severity: 'warn',
      context: {
        symbol,
        underlying: specification.underlying,
        action,
        reason,
        contracts,
        strike: specification.strike,
        underlierPrice,
        timestampMs,
      },
    });
    return settlement;
  }

  /**
   * Manually exercise a LONG American option early (WS7.4) — the `context.exercise` hook. `quantity` is
   * the number of contracts (≤ the current long position). Requires the `assignment: 'model'` policy.
   */
  exerciseOption(input: ExerciseOptionInput): OptionSettlement {
    const functionName = 'SimulatedBroker.exerciseOption';
    requireArgumentObject(functionName, 'input', input);
    ensureKnownKeys(functionName, 'input', input, [
      'symbol',
      'quantity',
      'timestampMs',
      'underlierMarks',
    ]);
    const { symbol, quantity, timestampMs, underlierMarks } = input;
    if (!this.assignmentModel) {
      throw new InputError(
        `${functionName}: early exercise requires the broker's assignment: 'model' policy.`,
        {
          code: ErrorCode.EngineUnsupportedContract,
          context: { symbol },
        },
      );
    }
    const specification = this.optionSpecs.get(symbol);
    if (!specification) {
      throw new InputError(`${functionName}: ${symbol} is not a registered option.`, {
        code: ErrorCode.InputMissingField,
        context: { symbol },
      });
    }
    if (specification.style !== 'american') {
      throw new InputError(
        `${functionName}: ${symbol} is European; only American options exercise early.`,
        {
          code: ErrorCode.EngineUnsupportedContract,
          context: { symbol, style: specification.style },
        },
      );
    }
    // Safe integer (2026-08-23 review, P0): a contract count above 2^53 is no longer exact, and
    // though the held-position check below bounds it in practice, the count must be real on its own.
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new InputError(
        `${functionName}: quantity must be a positive integer, got ${quantity}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { quantity },
        },
      );
    }
    const held = this.positions.get(symbol)?.quantity ?? 0;
    if (held < quantity) {
      throw new InputError(
        `${functionName}: cannot exercise ${quantity} of ${symbol}; the long position is ${held}.`,
        { code: ErrorCode.InputOutOfRange, context: { symbol, quantity, held } },
      );
    }
    const under =
      underlierMarks?.get(specification.underlying) ?? this.lastMark.get(specification.underlying);
    if (under === undefined || !Number.isFinite(under) || under <= 0) {
      throw new InputError(
        `${functionName}: no valid underlier price for ${specification.underlying}.`,
        {
          code: ErrorCode.InputMissingField,
          context: { underlying: specification.underlying, price: under },
        },
      );
    }
    return this.settleEarly({
      symbol,
      specification,
      contracts: quantity,
      underlierPrice: under,
      timestampMs,
      reason: 'manual',
    });
  }

  /** Submit an order; returns its id. Validates the request. */
  submit(request: OrderRequest): string {
    const functionName = 'SimulatedBroker.submit';
    requireArgumentObject(functionName, 'request', request);
    // Law 12: an `ocoGrup` typo silently un-linked the bracket - the exact class the closed
    // request exists to kill.
    ensureKnownKeys(functionName, 'request', request, [
      'symbol',
      'side',
      'quantity',
      'notional',
      'type',
      'limitPrice',
      'stopPrice',
      'timeInForce',
      'takeProfit',
      'stopLoss',
      'ocoGroup',
    ]);
    if (typeof request.symbol !== 'string' || request.symbol.length === 0) {
      throw new InputError(
        `${functionName}: symbol must be a non-empty symbol id. Received ${request.symbol === null ? 'null' : request.symbol === undefined ? 'undefined' : typeof request.symbol}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'symbol' } },
      );
    }
    if (request.ocoGroup !== undefined && typeof request.ocoGroup !== 'string') {
      throw new InputError(
        `${functionName}: ocoGroup must be a string when provided. Received ${request.ocoGroup === null ? 'null' : typeof request.ocoGroup}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'ocoGroup' } },
      );
    }
    for (const field of [
      'quantity',
      'notional',
      'limitPrice',
      'stopPrice',
      'takeProfit',
      'stopLoss',
    ] as const) {
      const value = request[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new InputError(
          `${functionName}: ${field} must be a finite number when provided. Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field } },
        );
      }
    }
    const hasQty = request.quantity !== undefined;
    const hasNotional = request.notional !== undefined;
    if (hasQty === hasNotional) {
      throw new InputError(`${functionName}: provide exactly one of quantity or notional.`, {
        code: ErrorCode.InputMissingField,
        context: { quantity: request.quantity, notional: request.notional },
      });
    }
    if (hasQty) ensurePositive(request.quantity!, 'quantity', functionName);
    if (hasNotional) ensurePositive(request.notional!, 'notional', functionName);
    // Pre-coalesce: `type: null` used to coalesce into 'market' and BUY AT MARKET a request that
    // never chose an order type. When present it must be a valid OrderType; only omission defaults.
    if (request.type !== undefined && !ORDER_TYPES.includes(request.type)) {
      throw new InputError(
        `${functionName}: type must be one of ${ORDER_TYPES.join(', ')} when provided. Received ${request.type === null ? 'null' : JSON.stringify(request.type)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'type' } },
      );
    }
    const type = request.type ?? 'market';
    if (request.side !== 'buy' && request.side !== 'sell') {
      throw new InputError(
        `${functionName}: side must be 'buy' or 'sell', got "${request.side}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { side: request.side },
        },
      );
    }
    // Reject unknown order types / TIF rather than letting a typo become a permanently-pending order
    // (unknown type never triggers) or a silently-mistreated TIF.
    if (!ORDER_TYPES.includes(type)) {
      throw new InputError(
        `${functionName}: type must be one of ${ORDER_TYPES.join(', ')}; got "${type}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { type },
        },
      );
    }
    if (request.timeInForce !== undefined && !TIME_IN_FORCE_VALUES.includes(request.timeInForce)) {
      throw new InputError(
        `${functionName}: timeInForce must be one of ${TIME_IN_FORCE_VALUES.join(', ')}; got "${request.timeInForce}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { timeInForce: request.timeInForce },
        },
      );
    }
    if ((type === 'limit' || type === 'stop-limit') && request.limitPrice === undefined) {
      throw new InputError(`${functionName}: ${type} order requires a limitPrice.`, {
        code: ErrorCode.InputMissingField,
        context: { type },
      });
    }
    if ((type === 'stop' || type === 'stop-limit') && request.stopPrice === undefined) {
      throw new InputError(`${functionName}: ${type} order requires a stopPrice.`, {
        code: ErrorCode.InputMissingField,
        context: { type },
      });
    }
    // Any supplied trigger / bracket price must be a positive finite number.
    if (request.limitPrice !== undefined)
      ensurePositive(request.limitPrice, 'limitPrice', functionName);
    if (request.stopPrice !== undefined)
      ensurePositive(request.stopPrice, 'stopPrice', functionName);
    if (request.takeProfit !== undefined)
      ensurePositive(request.takeProfit, 'takeProfit', functionName);
    if (request.stopLoss !== undefined) ensurePositive(request.stopLoss, 'stopLoss', functionName);
    const order: Order = {
      id: nextId(),
      symbol: request.symbol,
      side: request.side,
      type,
      quantity: request.quantity ?? 0,
      filledQuantity: 0,
      filledNotional: 0,
      status: 'pending',
      timeInForce: request.timeInForce ?? 'gtc',
      // The broker's clock is the bar stream: stamp the bar being processed when the order arrived
      // (a strategy submits while handling that bar). Before the first bar there is no clock — omit.
      ...(this.lastTs !== null ? { submittedTimestampMs: this.lastTs } : {}),
      ...(request.notional !== undefined ? { notional: request.notional } : {}),
      ...(request.limitPrice !== undefined ? { limitPrice: request.limitPrice } : {}),
      ...(request.stopPrice !== undefined ? { stopPrice: request.stopPrice } : {}),
      ...(request.ocoGroup !== undefined ? { ocoGroup: request.ocoGroup } : {}),
      ...(request.takeProfit !== undefined ? { takeProfit: request.takeProfit } : {}),
      ...(request.stopLoss !== undefined ? { stopLoss: request.stopLoss } : {}),
    };
    this._orders.push(order);
    return order.id;
  }

  /**
   * Per bracket group, the share quantity that bracket may exit — the parent's filled quantity.
   *
   * A hand-rolled OCO group (one a caller wired up with its own `ocoGroup`) has no entry here, and
   * cannot: nothing declares what such a group owns.
   */
  private readonly bracketCapacity = new Map<string, number>();

  /** Cancel a pending order (and its OCO group). */
  cancel(id: string): void {
    const order = this.orders.find((o) => o.id === id);
    if (order && (order.status === 'pending' || order.status === 'partially-filled')) {
      order.status = 'cancelled';
      if (order.ocoGroup) this.cancelGroup(order.ocoGroup, order.id);
    }
  }

  /**
   * After a PARTIAL fill of an OCO member, re-size its siblings to the position that is actually
   * left to exit, cancelling any sibling with nothing left to do.
   *
   * OCO siblings used to be cancelled only on a COMPLETE fill, so a partially-filled bracket leg
   * left BOTH legs alive at their original size. A 10-lot bracket throttled to 5 lots/bar exited 5
   * on the take-profit and 5 on the stop for a flat book — then filled the two 5-lot remainders on
   * the next bar and went 10 lots SHORT, a position the strategy never asked for.
   */
  private reduceGroupToOpenPosition(order: Order, fillPrice: number): void {
    const group = order.ocoGroup!;
    const remaining = this.groupRemaining(group, order.symbol);
    for (const o of this.orders) {
      if (o.ocoGroup !== group || o.id === order.id) continue;
      if (o.status !== 'pending' && o.status !== 'partially-filled') continue;
      if (!(remaining > 1e-9)) {
        o.status = 'cancelled';
        continue;
      }
      if (o.notional !== undefined) {
        // A notional sibling's cap is expressed in cash: value the units still open at the price
        // the sibling's own symbol just printed at (the only price this bar establishes for it),
        // in the cash a unit of that symbol moves.
        o.notional = Math.min(
          o.notional,
          o.filledNotional + remaining * fillPrice * this.multiplierOf(o.symbol),
        );
      } else {
        o.quantity = Math.min(o.quantity, o.filledQuantity + remaining);
      }
    }
  }

  /**
   * How many shares this OCO group still has the right to exit.
   *
   * The first version asked the ACCOUNT — `Math.abs(this.position(symbol).quantity)` — which is only
   * the bracket's own size when the bracket is the entire position. Layer a 10-share bracket on top
   * of a 100-share holding and the siblings resized against 110: a take-profit filling 5 left the
   * stop at its full 10, so the bracket exited 15 shares of a position it owned 10 of, and the
   * original holding came back 95 instead of 100. The regression that caught the ORIGINAL bug
   * started flat, where the two numbers coincide, so it could not see this one.
   *
   * A bracket is bounded by BOTH its own capacity and the position actually held — it may not exit
   * shares it never owned, and it may not exit shares the strategy has already closed out from under
   * it. A hand-rolled OCO group has no declared capacity, so the held position is the only bound
   * available and it keeps the previous behaviour.
   */
  private groupRemaining(group: string, symbol: SymbolId): number {
    const held = Math.abs(this.position(symbol).quantity);
    const capacity = this.bracketCapacity.get(group);
    if (capacity === undefined) return held;
    let exited = 0;
    for (const o of this.orders) if (o.ocoGroup === group) exited += o.filledQuantity;
    return Math.max(0, Math.min(capacity - exited, held));
  }

  private cancelGroup(group: string, exceptId: string): void {
    // The group is over — a member filled completely, or the caller cancelled it. Nothing else will
    // consult its capacity, and a backtest may open thousands of brackets.
    this.bracketCapacity.delete(group);
    for (const o of this.orders) {
      if (
        o.ocoGroup === group &&
        o.id !== exceptId &&
        (o.status === 'pending' || o.status === 'partially-filled')
      ) {
        o.status = 'cancelled';
      }
    }
  }

  /**
   * Advance the broker by one bar: apply corporate actions, accrue borrow on shorts, then try to fill
   * every working order for this bar's symbol. Returns this bar's fills.
   */
  processBar(bar: Bar, action?: CorporateAction): Trade[] {
    requireArgumentObject('SimulatedBroker.processBar', 'bar', bar);
    if (action !== undefined) {
      requireArgumentObject('SimulatedBroker.processBar', 'action', action);
      // Law 12: a `divident` typo must teach, never silently skip the cash flow.
      ensureKnownKeys('SimulatedBroker.processBar', 'action', action, [
        'dividend',
        'split',
      ] as const);
      const splitValue = (action as unknown as Record<string, unknown>)['split'];
      if (
        splitValue !== undefined &&
        (typeof splitValue !== 'number' || !Number.isFinite(splitValue))
      ) {
        throw new InputError(
          `SimulatedBroker.processBar: action.split must be a finite split ratio when provided. Received ${splitValue === null ? 'null' : typeof splitValue}.`,
          { code: ErrorCode.InputWrongType, context: { field: 'split' } },
        );
      }
      const dividendValue = (action as unknown as Record<string, unknown>)['dividend'];
      if (
        dividendValue !== undefined &&
        (typeof dividendValue !== 'number' || !Number.isFinite(dividendValue))
      ) {
        throw new InputError(
          `SimulatedBroker.processBar: action.dividend must be a finite number when provided. Received ${dividendValue === null ? 'null' : typeof dividendValue}.`,
          { code: ErrorCode.InputWrongType, context: { field: 'dividend' } },
        );
      }
    }
    if (bar.adjusted !== undefined && typeof bar.adjusted !== 'boolean') {
      throw new InputError(
        `SimulatedBroker.processBar: bar.adjusted must be a boolean when present. Received ${bar.adjusted === null ? 'null' : typeof bar.adjusted}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'adjusted' } },
      );
    }
    validateBar(bar, 'SimulatedBroker.processBar');
    this.lastTs = bar.timestampMs; // the broker's "now" — stamped on orders submitted during this bar
    const sym = bar.symbol;
    // 0. American early exercise/assignment (WS7.4, opt-in). Runs BEFORE the dividend so an assigned
    // covered call surrenders the stock — and thus the dividend — the day the ex-div is known.
    if (this.assignmentModel) this.earlyAssignmentsForBar(bar, action);
    // 1. corporate actions (split first, then dividend on the post-split quantity)
    if (action?.split && action.split > 0 && action.split !== 1) {
      this.applySplit(sym, action.split);
    }
    if (action?.dividend && action.dividend !== 0) {
      const pos = this.positions.get(sym);
      if (pos) this.cash += pos.quantity * action.dividend; // long credited, short debited
    }
    // 2. borrow accrual on a short carried since the last bar
    if (this.brw.annualRate > 0) {
      const pos = this.positions.get(sym);
      const prevMark = this.lastMark.get(sym);
      if (pos && pos.quantity < 0 && prevMark !== undefined) {
        this.cash -=
          (Math.abs(pos.quantity) * prevMark * this.brw.annualRate) / this.periodsPerYear;
      }
    }
    // 3. fill working orders for this symbol
    const fills: Trade[] = [];
    for (const order of this.orders) {
      if (order.symbol !== sym) continue;
      if (order.status !== 'pending' && order.status !== 'partially-filled') continue;
      const fill = this.tryFill(order, bar);
      if (fill) {
        fills.push(fill);
        // tryFill may have advanced status to 'filled'; the cast defeats the stale control-flow
        // narrowing TS carries from the `continue` guard above (it can't see the mutation).
        if ((order.status as OrderStatus) === 'filled') this.onParentFilled(order, bar);
      }
      // expire unfilled day orders at the end of the bar
      if (
        order.timeInForce === 'day' &&
        (order.status === 'pending' || order.status === 'partially-filled')
      ) {
        order.status = 'cancelled';
      }
    }
    this.lastMark.set(sym, bar.close);
    return fills;
  }

  /**
   * Apply an `R`-for-1 split to one symbol: quantities ×R and prices ÷R, EVERYWHERE the broker
   * holds one — the position, the last mark, and every resting order.
   *
   * Adjusting only the position (the old behaviour) left three silent wrong numbers behind:
   *
   * - a resting limit/stop kept its PRE-split trigger, so a GTC "buy limit 90" on a stock that split
   *   2:1 from 100 to 50 fired instantly at 50 — a phantom fill on a price that never moved;
   * - the stale `lastMark` was still the pre-split price while the position had already doubled, so
   *   the borrow accrual on a short charged 2× the real market value for that bar;
   * - a resting order's `quantity` kept its pre-split share count, silently halving the economic
   *   size of the order the caller placed.
   *
   * Cash quantities are NOT scaled: a notional order's dollar amount and the notional already filled
   * are unaffected by a split. Every adjusted order is disclosed via `backtest.order_split_adjusted`.
   */
  private applySplit(symbol: SymbolId, ratio: number): void {
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.quantity *= ratio;
      pos.averagePrice /= ratio;
    }
    const mark = this.lastMark.get(symbol);
    if (mark !== undefined) this.lastMark.set(symbol, mark / ratio);
    for (const o of this.orders) {
      if (o.symbol !== symbol) continue;
      if (o.status !== 'pending' && o.status !== 'partially-filled') continue;
      const before = {
        quantity: o.quantity,
        limitPrice: o.limitPrice,
        stopPrice: o.stopPrice,
        takeProfit: o.takeProfit,
        stopLoss: o.stopLoss,
      };
      // Prices ÷ ratio — BOTH of a stop-limit's prices, and the bracket triggers a resting parent
      // will hand to its children when it fills.
      if (o.limitPrice !== undefined) o.limitPrice /= ratio;
      if (o.stopPrice !== undefined) o.stopPrice /= ratio;
      if (o.takeProfit !== undefined) o.takeProfit /= ratio;
      if (o.stopLoss !== undefined) o.stopLoss /= ratio;
      // Share counts × ratio (a notional order carries quantity 0 and is sized at fill, so it is
      // untouched); `filledQuantity` scales with it so the REMAINING size stays economically equal.
      o.quantity *= ratio;
      o.filledQuantity *= ratio;
      this._warnings.push({
        code: ErrorCode.BacktestOrderSplitAdjusted,
        message:
          `Order ${o.id} (${o.type} ${o.side} ${symbol}) was adjusted for a ${ratio}-for-1 split: ` +
          `quantity ${before.quantity} → ${o.quantity}` +
          (before.limitPrice !== undefined
            ? `, limitPrice ${before.limitPrice} → ${o.limitPrice}`
            : '') +
          (before.stopPrice !== undefined
            ? `, stopPrice ${before.stopPrice} → ${o.stopPrice}`
            : '') +
          (before.takeProfit !== undefined
            ? `, takeProfit ${before.takeProfit} → ${o.takeProfit}`
            : '') +
          (before.stopLoss !== undefined ? `, stopLoss ${before.stopLoss} → ${o.stopLoss}` : '') +
          '.',
        severity: 'info',
        context: {
          order: o.id,
          symbol,
          split: ratio,
          before,
          after: {
            quantity: o.quantity,
            limitPrice: o.limitPrice,
            stopPrice: o.stopPrice,
            takeProfit: o.takeProfit,
            stopLoss: o.stopLoss,
          },
        },
      });
    }
  }

  /** When a bracket parent fills, activate its OCO take-profit / stop-loss children. */
  private onParentFilled(order: Order, bar: Bar): void {
    if (order.takeProfit === undefined && order.stopLoss === undefined) return;
    const exitSide: OrderSide = order.side === 'buy' ? 'sell' : 'buy';
    const group = `bracket-${order.id}`;
    const exitQty = order.filledQuantity; // the actual position to exit (works for notional orders too)
    // What this bracket is entitled to exit, recorded at the moment it is entitled to it. Recovering
    // it later is not possible: `reduceGroupToOpenPosition` resizes the siblings, so by the second
    // partial fill their quantities no longer say how large the bracket was.
    this.bracketCapacity.set(group, exitQty);
    if (order.takeProfit !== undefined) {
      this.submit({
        symbol: order.symbol,
        side: exitSide,
        quantity: exitQty,
        type: 'limit',
        limitPrice: order.takeProfit,
        ocoGroup: group,
        timeInForce: 'gtc',
      });
    }
    if (order.stopLoss !== undefined) {
      this.submit({
        symbol: order.symbol,
        side: exitSide,
        quantity: exitQty,
        type: 'stop',
        stopPrice: order.stopLoss,
        ocoGroup: group,
        timeInForce: 'gtc',
      });
    }
    void bar;
  }

  /** Attempt to fill one order against a bar; returns the trade or null if it doesn't fill. */
  private tryFill(order: Order, bar: Bar): Trade | null {
    const ref = this.triggerPrice(order, bar);
    if (ref === null) return null;
    // The cash a unit of this symbol moves per point of price: 1 for a share, the registered
    // contract multiplier for an option. Every cash figure below — notional sizing, commission,
    // slippage, the fill's own value — is quoted in it, so a 100-share contract is never billed,
    // sized or reported as one share.
    const multiplier = this.multiplierOf(order.symbol);

    // Two-pass sizing: estimate the intended quantity at the reference price first, so a
    // size-dependent slippage model sees the REAL order size (the old code hardcoded qty = 1). Then
    // re-quantize a notional order once at the slipped price — a single iteration, no second slip call.
    let intendedQty =
      order.notional !== undefined
        ? (order.notional - order.filledNotional) / (ref * multiplier)
        : order.quantity - order.filledQuantity;
    /**
     * A BRACKET may never exit more than it owns, and the sibling-resize path alone cannot promise
     * that: resizing happens after a PARTIAL fill, so a leg that fills completely in one go never
     * passes through it. Close a bracketed position by hand and leave the bracket working, and the
     * next bar to touch the take-profit sold ten shares that were no longer there — flipping the
     * book short, the same "position the strategy never asked for" the resize was added to prevent.
     *
     * Only bracket groups are capped. The broker created both of those legs and owns their
     * lifecycle; a hand-rolled OCO group is the caller's own resting order, and cancelling it out
     * from under them because the account went flat would be the simulator inventing policy.
     */
    if (order.ocoGroup !== undefined && this.bracketCapacity.has(order.ocoGroup)) {
      const owned = this.groupRemaining(order.ocoGroup, order.symbol);
      if (!(owned > 1e-9)) {
        this.cancelGroup(order.ocoGroup, order.id);
        order.status = 'cancelled';
        return null;
      }
      if (owned < intendedQty) intendedQty = owned;
    }
    if (Number.isFinite(this.participation) && bar.volume !== undefined) {
      const cap = bar.volume * this.participation;
      if (cap < intendedQty) intendedQty = cap;
    }
    if (!(intendedQty > 0)) return null;

    const fillPrice = this.slip.fill({
      referencePrice: ref,
      side: order.side,
      quantity: intendedQty,
    });
    let qty =
      order.notional !== undefined
        ? (order.notional - order.filledNotional) / (fillPrice * multiplier)
        : intendedQty;
    if (Number.isFinite(this.participation) && bar.volume !== undefined) {
      const cap = bar.volume * this.participation;
      if (cap < qty) qty = cap;
    }
    if (!(qty > 0)) return null;

    if (this.noShort) {
      const pos = this.position(order.symbol);
      const after = pos.quantity + (order.side === 'buy' ? qty : -qty);
      if (after < -1e-9) {
        order.status = 'cancelled';
        this._warnings.push({
          code: WarningCode.BacktestShortRejected,
          message: `Order ${order.id} would open a short while noShort is set; cancelled.`,
          severity: 'warn',
          context: { order: order.id },
        });
        return null;
      }
    }

    // leverage cap (margin): reject the fill if it would breach the gross-leverage limit
    if (Number.isFinite(this.maxLeverage)) {
      if (this.wouldBreachLeverage(order.symbol, order.side, qty, fillPrice, bar)) {
        order.status = 'cancelled';
        this._warnings.push({
          code: WarningCode.BacktestMarginRejected,
          message: `Order ${order.id} would breach the ${this.maxLeverage}× gross-leverage limit; cancelled.`,
          severity: 'warn',
          context: { order: order.id, maxLeverage: this.maxLeverage },
        });
        return null;
      }
    }

    // Commission is charged on the price the trade actually PRINTED at, not on the pre-slippage
    // reference: a bps schedule billed at `ref` under-charged every buy and over-charged every sell
    // by exactly the slippage, so the modelled cost drifted from the modelled fill. The price is
    // the cash price of one unit (premium × multiplier for a contract), exactly as the shared fill
    // kernel bills it, so a bps schedule sees the contract's notional and a per-unit schedule
    // sees the contract count.
    const commission = this.fee.commission({ quantity: qty, price: fillPrice * multiplier });
    this.applyFill({
      symbol: order.symbol,
      side: order.side,
      quantity: qty,
      price: fillPrice,
      commission,
    });
    // Under unconstrained leverage a fill can drive cash negative (unfunded). Surface it ONCE, and
    // keep the low-water mark current on the same warning object so the final result carries it.
    if (this.cash < this.cashLowWater) this.cashLowWater = this.cash;
    if (this.cash < 0) {
      if (!this.negativeCashWarning) {
        this.negativeCashWarning = {
          code: WarningCode.BacktestNegativeCash,
          message:
            'Cash went negative — unconstrained leverage (maxLeverage = Infinity) permitted an unfunded fill.',
          severity: 'warn',
          context: { firstTs: bar.timestampMs, lowWaterCash: this.cash },
        };
        this._warnings.push(this.negativeCashWarning);
      }
      this.negativeCashWarning.context!['lowWaterCash'] = this.cashLowWater;
    }
    order.filledQuantity += qty;
    order.filledNotional += qty * fillPrice * multiplier;
    const done =
      order.notional !== undefined
        ? order.filledNotional >= order.notional - 1e-6 * Math.max(1, order.notional)
        : order.filledQuantity >= order.quantity - 1e-9;
    order.status = done ? 'filled' : 'partially-filled';
    if (order.ocoGroup) {
      if (order.status === 'filled') {
        this.cancelGroup(order.ocoGroup, order.id); // one-cancels-other: unchanged on a FULL fill
      } else {
        this.reduceGroupToOpenPosition(order, fillPrice);
      }
    }

    const trade: Trade = {
      symbol: order.symbol,
      timestampMs: bar.timestampMs,
      side: order.side,
      quantity: qty,
      price: fillPrice,
      commission,
      // Slippage is a cash cost like commission: the per-unit price concession times the cash a
      // unit moves. Left in premium points, an option's slippage was reported at 1% of its size.
      slippage: qty * Math.abs(fillPrice - ref) * multiplier,
      // The contract multiplier this symbol trades in (1 for a share, the registered option's
      // multiplier otherwise) — so downstream turnover / realized-P&L attribution can value the
      // fill in cash without re-deriving the instrument's registration.
      multiplier,
    };
    this._trades.push(trade);
    return trade;
  }

  /** The reference (pre-slippage) execution price if `order` triggers on `bar`, else null. */
  private triggerPrice(order: Order, bar: Bar): number | null {
    const { open, high, low, close } = bar;
    switch (order.type) {
      case 'market':
      case 'market-on-open':
        return open;
      case 'market-on-close':
        // The bar's close is the auction print a bar simulator has; slippage applies after.
        return close;
      case 'limit': {
        const L = order.limitPrice!;
        if (order.side === 'buy') return open <= L ? open : low <= L ? L : null;
        return open >= L ? open : high >= L ? L : null;
      }
      case 'stop': {
        const S = order.stopPrice!;
        if (order.side === 'buy') return high >= S ? Math.max(open, S) : null;
        return low <= S ? Math.min(open, S) : null;
      }
      case 'stop-limit': {
        const S = order.stopPrice!;
        const L = order.limitPrice!;
        const triggered = order.side === 'buy' ? high >= S : low <= S;
        if (!triggered) return null;
        // A stop-limit is NOT a live limit order until the stop trips. Evaluating the limit against
        // the bar's raw `open` filled at a price that existed BEFORE the order was working: a buy
        // stop-limit (stop 100, limit 100) on a bar that opened at 95 and rallied through 100 used to
        // fill at 95 — a free 5 points the order could never have captured. The order's effective
        // open is therefore the stop price, unless the bar already GAPPED through it (open beyond the
        // stop), which is the same flooring the plain `stop` case applies via Math.max/Math.min.
        if (order.side === 'buy') {
          const entry = Math.max(open, S);
          return entry <= L ? entry : low <= L ? L : null;
        }
        const entry = Math.min(open, S);
        return entry >= L ? entry : high >= L ? L : null;
      }
      default:
        return null;
    }
  }

  private applyFill(input: {
    symbol: SymbolId;
    side: OrderSide;
    quantity: number;
    price: number;
    commission: number;
  }): void {
    const { symbol, side, quantity: qty, price, commission } = input;
    const signed = signOf(side) * qty;
    this.cash -= signed * price * this.multiplierOf(symbol) + commission;
    const pos = this.positions.get(symbol) ?? { symbol, quantity: 0, averagePrice: 0 };
    const newQty = pos.quantity + signed;
    if (pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(newQty) || newQty === 0) {
      // adding to (or flattening) a position: weighted-average the entry price when growing
      if (Math.abs(newQty) > Math.abs(pos.quantity)) {
        pos.averagePrice = (pos.averagePrice * pos.quantity + price * signed) / newQty;
      }
    } else {
      // crossed through zero: the remainder opens a fresh position at this price
      pos.averagePrice = price;
    }
    pos.quantity = newQty;
    if (Math.abs(pos.quantity) < 1e-12) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, pos);
    }
  }

  private wouldBreachLeverage(
    symbol: SymbolId,
    side: OrderSide,
    qty: number,
    price: number,
    bar: Bar,
  ): boolean {
    const marks = new Map(this.lastMark);
    marks.set(symbol, bar.close);
    const equity = this.equity(marks);
    if (!(equity > 0)) return true;
    let gross = 0;
    for (const pos of this.positions.values()) {
      const m = marks.get(pos.symbol) ?? pos.averagePrice;
      gross += Math.abs(pos.quantity * m) * this.multiplierOf(pos.symbol);
    }
    const pos = this.position(symbol);
    const mult = this.multiplierOf(symbol);
    const before = Math.abs(pos.quantity * bar.close) * mult;
    const after = Math.abs((pos.quantity + signOf(side) * qty) * bar.close) * mult;
    gross += after - before;
    void price;
    return gross / equity > this.maxLeverage + 1e-9;
  }
}
