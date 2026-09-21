/**
 * Vectorized research backtest engine (spec §16.1).
 *
 * A fast, deterministic single-asset loop: a target-weight `signal` per bar drives a share-based
 * position that is rebalanced on a calendar, with transaction costs, slippage, and short borrow fees.
 * Execution is **lagged one bar by default** — the signal at bar `i` only affects the position held
 * into bar `i+1` — so the engine cannot peek at the return it is trading on (the result's
 * implementation-risk block flags it if you turn the lag off).
 *
 *   backtest.vectorized({ data: candles, signal, rebalance: 'monthly', fees: fees.bps(1) });
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  missingFieldError,
  requireArgumentArray,
  sideOf,
  WarningCode,
} from '@totalfinance/core';
import { analyze } from '@totalfinance/performance';
import {
  type BorrowModel,
  type CostModel,
  type SlippageModel,
  borrow as borrowNs,
  fees as feesNs,
  slippage as slipNs,
} from './costs.js';
import { checkDataAlignment } from './diagnostics.js';
import type { EnvelopeSignal, SeriesSignal } from './signals.js';
import { requireBarData } from './validate.js';
import {
  BENCHMARK_FIXTURE_VERSION,
  type Bar,
  type BacktestAssumptions,
  type BacktestResult,
  type ImplementationRisk,
  type Trade,
  toEquityPoints,
} from './types.js';

/** Rebalance calendar: every bar, on a date/week/month boundary, or every `N` bars. */
export type RebalanceRule = 'everyBar' | 'daily' | 'weekly' | 'monthly' | number;

export interface VectorizedOptions {
  /** Price bars in ascending time order. */
  data: Bar[];
  /**
   * Target exposure per bar, aligned to `data`. A boolean is long (`1`) / flat (`0`); a number is a
   * target weight (fraction of equity; negative = short), clamped to `maxLeverage`.
   *
   * Accepts a warmup-aware {@link SeriesSignal} (`{ value, warmup }`, e.g. a `technicalAnalysis.*.explain(...)`
   * result) so an indicator's leading warmup NaNs are treated as flat (position 0) instead of
   * throwing. A bare `number[]`/`Float64Array` has an implicit `warmup` of 0, so any NaN in it still
   * throws (a genuine mid-series NaN is a real error, not warmup).
   */
  signal: ArrayLike<number | boolean> | SeriesSignal | EnvelopeSignal;
  /** Rebalance calendar (default `everyBar`). */
  rebalance?: RebalanceRule;
  /** Commission model (default `fees.none()`). */
  fees?: CostModel;
  /** Slippage model (default `slippage.none()`). */
  slippage?: SlippageModel;
  /** Short borrow-fee model (default `borrow.none()`). */
  borrow?: BorrowModel;
  /** Opening capital (default 1). */
  initialCapital?: number;
  /** Bars per year, for annualized metrics (default 252). */
  periodsPerYear?: number;
  /** Per-asset gross weight cap applied to the signal (default 1). */
  maxLeverage?: number;
  /** Bars between observing the signal and trading on it; ≥ 1 avoids look-ahead (default 1). */
  executionLag?: number;
  /** Annualized risk-free rate for Sharpe/Sortino (default 0). */
  riskFreeRate?: number;
}

function weightOf(sig: number | boolean): number {
  if (typeof sig === 'boolean') return sig ? 1 : 0;
  // A non-finite value only reaches here for a warmup bar (validated below); trade it flat.
  if (!Number.isFinite(sig)) return 0;
  return sig;
}

/**
 * Structurally detect the warmup-aware {@link SeriesSignal} shape. A bare array / typed array is
 * NOT a SeriesSignal (it has no `warmup`), so it keeps its unchanged "any NaN throws" behavior.
 */
function isSeriesSignal(
  s: ArrayLike<number | boolean> | SeriesSignal | EnvelopeSignal,
): s is SeriesSignal {
  return (
    typeof s === 'object' &&
    s !== null &&
    !Array.isArray(s) &&
    !(s instanceof Float64Array) &&
    'warmup' in s
  );
}

/** A technicalAnalysis.*.explain(...) envelope used directly as the signal (warmup in diagnostics.warmup). */
function isEnvelopeSignal(
  s: ArrayLike<number | boolean> | SeriesSignal | EnvelopeSignal,
): s is EnvelopeSignal {
  return (
    typeof s === 'object' &&
    s !== null &&
    !Array.isArray(s) &&
    'diagnostics' in s &&
    typeof (s as EnvelopeSignal).diagnostics?.warmup === 'number'
  );
}

/** Normalize any accepted signal to `{ values, warmup }`; a bare array/typed array has `warmup = 0`. */
function normalizeSignal(signal: ArrayLike<number | boolean> | SeriesSignal | EnvelopeSignal): {
  values: ArrayLike<number | boolean>;
  warmup: number;
} {
  if (isEnvelopeSignal(signal)) return { values: signal.value, warmup: signal.diagnostics.warmup };
  return isSeriesSignal(signal)
    ? { values: signal.value, warmup: signal.warmup }
    : { values: signal, warmup: 0 };
}

/** Boolean mask of which bars trigger a rebalance under `rule`. The first bar is always eligible. */
function rebalanceMask(bars: Bar[], rule: RebalanceRule): boolean[] {
  const n = bars.length;
  const mask = new Array<boolean>(n).fill(false);
  if (n === 0) return mask;
  mask[0] = true;
  if (typeof rule === 'number') {
    // Safe integer (2026-08-23 review, P0): the mask loop is bounded by the bar count, but
    // `i % rule` needs an exact modulus — above 2^53 the rule is no longer the number typed.
    if (!Number.isSafeInteger(rule) || rule < 1) {
      throw new InputError(
        `vectorized: numeric rebalance must be a positive integer, got ${rule}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { rebalance: rule },
        },
      );
    }
    for (let i = 0; i < n; i++) mask[i] = i % rule === 0;
    mask[0] = true;
    return mask;
  }
  if (rule === 'everyBar') return mask.fill(true);
  // boundary-driven: a new day / ISO-week / month relative to the previous bar (deterministic on ts).
  const key = (ts: number): string => {
    const d = new Date(ts);
    if (rule === 'daily') return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (rule === 'monthly') return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (rule === 'weekly') {
      // ISO week number
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const day = new Date(t).getUTCDay() || 7;
      const thursday = t + (4 - day) * 86_400_000;
      const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
      return `${new Date(thursday).getUTCFullYear()}-${Math.ceil(
        ((thursday - yearStart) / 86_400_000 + 1) / 7,
      )}`;
    }
    throw new InputError(`vectorized: unknown rebalance rule "${String(rule)}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { rebalance: rule },
    });
  };
  let prev = key(bars[0]!.timestampMs);
  for (let i = 1; i < n; i++) {
    const k = key(bars[i]!.timestampMs);
    if (k !== prev) mask[i] = true;
    prev = k;
  }
  return mask;
}

/** EXACT {@link VectorizedOptions} fields (Law 12) — unknown keys are rejected, never ignored. */
const VECTORIZED_KEYS = [
  'data',
  'signal',
  'rebalance',
  'fees',
  'slippage',
  'borrow',
  'initialCapital',
  'periodsPerYear',
  'maxLeverage',
  'executionLag',
  'riskFreeRate',
] as const;

/** Run a single-asset vectorized backtest. */
export function vectorized(options: VectorizedOptions): BacktestResult {
  const functionName = 'vectorized';
  requireBarData(
    options,
    functionName,
    '{ data: Bar[], signal, initialCapital?, fees?, slippage?, rebalance?, … }',
  );
  // A near-miss capital key would otherwise be silently ignored and the run would start at the
  // default capital of 1 — reject the alias and point at the real option instead (dx §2.5 honesty).
  for (const alias of ['initialCash', 'cash'] as const) {
    if (alias in options) {
      throw new InputError(
        `${functionName}: unknown option "${alias}" — opening capital is set via initialCapital.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { received: alias, expected: 'initialCapital' },
        },
      );
    }
  }
  ensureKnownKeys(functionName, 'options', options, VECTORIZED_KEYS);
  // When-present ladders (the 350c2796 ruling: null is a wrong-typed value, not omission).
  for (const numField of ['initialCapital', 'maxLeverage'] as const) {
    const numValue = (options as unknown as Record<string, unknown>)[numField];
    if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
      throw new InputError(
        `${functionName}: ${numField} must be a finite number when provided. Received ${numValue === null ? 'null' : typeof numValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: numField } },
      );
    }
  }
  const rebalanceValue = (options as unknown as Record<string, unknown>)['rebalance'];
  if (
    rebalanceValue !== undefined &&
    rebalanceValue !== 'everyBar' &&
    rebalanceValue !== 'daily' &&
    rebalanceValue !== 'weekly' &&
    rebalanceValue !== 'monthly' &&
    (typeof rebalanceValue !== 'number' || !Number.isFinite(rebalanceValue))
  ) {
    throw new InputError(
      `${functionName}: rebalance must be 'everyBar' | 'daily' | 'weekly' | 'monthly' or a finite bar count when provided. Received ${rebalanceValue === null ? 'null' : JSON.stringify(rebalanceValue)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'rebalance' } },
    );
  }
  // The models are INVOKED per trade: a shape failure here would otherwise surface bars deep in
  // the run as a raw "not a function" with no field name.
  const feesValue = (options as unknown as Record<string, unknown>)['fees'];
  if (
    feesValue !== undefined &&
    (feesValue === null ||
      typeof feesValue !== 'object' ||
      typeof (feesValue as { commission?: unknown }).commission !== 'function' ||
      typeof (feesValue as { label?: unknown }).label !== 'string')
  ) {
    throw new InputError(
      `${functionName}: fees must be a cost model ({ label, commission(input) } — e.g. fees.bps(1)) when provided. Received ${feesValue === null ? 'null' : typeof feesValue}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'fees' } },
    );
  }
  const slippageValue = (options as unknown as Record<string, unknown>)['slippage'];
  if (
    slippageValue !== undefined &&
    (slippageValue === null ||
      typeof slippageValue !== 'object' ||
      typeof (slippageValue as { fill?: unknown }).fill !== 'function' ||
      typeof (slippageValue as { label?: unknown }).label !== 'string')
  ) {
    throw new InputError(
      `${functionName}: slippage must be a slippage model ({ label, fill(input) } — e.g. slippageModels.bps(2)) when provided. Received ${slippageValue === null ? 'null' : typeof slippageValue}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'slippage' } },
    );
  }
  if (options.signal === undefined || options.signal === null) {
    throw missingFieldError(
      functionName,
      'signal',
      'vectorized({ data, signal: data.map(() => true) })',
      'one target weight or flag per bar',
    );
  }
  const { data } = options;
  if (data.length < 2) {
    throw new InputError(`${functionName}: need ≥ 2 bars, got ${data.length}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { bars: data.length },
    });
  }
  // Accept a warmup-aware SeriesSignal ({ value, warmup }); a bare array normalizes to warmup 0.
  const { values: signalValues, warmup: signalWarmup } = normalizeSignal(options.signal);
  // A series/envelope signal whose `value` is missing or not array-like used to crash on
  // `.length` below as a raw TypeError with no field name.
  if (
    signalValues === null ||
    signalValues === undefined ||
    typeof (signalValues as { length?: unknown }).length !== 'number'
  ) {
    throw new InputError(
      `${functionName}: signal must be an array of target weights, a { value, warmup } series, or a technical-analysis explain envelope — its values were ${signalValues === null ? 'null' : typeof signalValues}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'signal.value' } },
    );
  }
  if (typeof signalWarmup !== 'number' || !Number.isFinite(signalWarmup)) {
    throw new InputError(
      `${functionName}: signal.warmup must be a finite number. Received ${signalWarmup === null ? 'null' : typeof signalWarmup}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'signal.warmup' } },
    );
  }
  if (signalValues.length !== data.length) {
    throw new InputError(
      `${functionName}: signal length (${signalValues.length}) must match data length (${data.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { signal: signalValues.length, data: data.length },
      },
    );
  }
  // Safe integer (2026-08-23 review, P0): warmup is an index threshold compared against
  // data-bounded loop counters — above 2^53 it is no longer exact.
  if (!Number.isSafeInteger(signalWarmup) || signalWarmup < 0) {
    throw new InputError(
      `${functionName}: signal warmup must be a non-negative integer, got ${signalWarmup}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { warmup: signalWarmup },
      },
    );
  }
  // A non-finite numeric weight would silently skip a rebalance (NaN comparisons are false). It's an
  // error EXCEPT within the declared warmup, where an indicator is NaN by design: there we count it
  // and trade the bar flat (position 0). A non-finite value at or after `warmup` still throws.
  let warmupSkipped = 0;
  for (let i = 0; i < signalValues.length; i++) {
    const s = signalValues[i]!;
    if (typeof s !== 'number' || Number.isFinite(s)) continue;
    if (i < signalWarmup) {
      warmupSkipped++;
      continue;
    }
    ensureFinite(s, `signal[${i}]`, functionName); // i >= warmup: a genuine mid-series NaN — throw.
  }
  const initialCapital = options.initialCapital ?? 1;
  ensurePositive(initialCapital, 'initialCapital', functionName);
  if (
    (options as unknown as Record<string, unknown>)['periodsPerYear'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['periodsPerYear'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['periodsPerYear'] as number))
  ) {
    throw new InputError(
      `vectorized: periodsPerYear must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['periodsPerYear'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['periodsPerYear']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'periodsPerYear' } },
    );
  }
  const periodsPerYear = options.periodsPerYear ?? 252;
  ensurePositive(periodsPerYear, 'periodsPerYear', functionName);
  const maxLeverage = options.maxLeverage ?? 1;
  ensurePositive(maxLeverage, 'maxLeverage', functionName);
  if (
    (options as unknown as Record<string, unknown>)['executionLag'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['executionLag'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['executionLag'] as number))
  ) {
    throw new InputError(
      `vectorized: executionLag must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['executionLag'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['executionLag']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'executionLag' } },
    );
  }
  const lag = options.executionLag ?? 1;
  // Safe integer (2026-08-23 review, P0): the lag shifts data-bounded indices — above 2^53 the
  // offset is no longer exact.
  if (!Number.isSafeInteger(lag) || lag < 0) {
    throw new InputError(
      `${functionName}: executionLag must be a non-negative integer, got ${lag}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { executionLag: lag },
      },
    );
  }
  if (options.fees !== undefined && (options.fees === null || typeof options.fees !== 'object')) {
    throw new InputError(
      `vectorized: fees must be a cost-model object when provided — build one with the fees namespace. Received ${options.fees === null ? 'null' : typeof options.fees}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'fees' } },
    );
  }
  const fee = options.fees ?? feesNs.none();
  const slip = options.slippage ?? slipNs.none();
  if (
    options.borrow !== undefined &&
    (options.borrow === null || typeof options.borrow !== 'object')
  ) {
    throw new InputError(
      `vectorized: borrow must be a borrow-model object when provided — build one with the borrow namespace. Received ${options.borrow === null ? 'null' : typeof options.borrow}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'borrow' } },
    );
  }
  const brw = options.borrow ?? borrowNs.none();
  const rule: RebalanceRule = options.rebalance ?? 'everyBar';
  const symbol = data[0]!.symbol;
  // The vectorized engine models a SINGLE instrument; a multi-symbol series would silently backtest
  // one symbol's signal against another's prices. Reject it rather than trust input order.
  for (let i = 1; i < data.length; i++) {
    if (data[i]!.symbol !== symbol) {
      throw new InputError(
        `${functionName}: all bars must share one symbol; bar ${i} is "${
          data[i]!.symbol
        }" but bar 0 is "${symbol}".`,
        {
          code: ErrorCode.BacktestMixedSymbols,
          context: { index: i, expected: symbol, found: data[i]!.symbol },
        },
      );
    }
  }

  const n = data.length;
  const mask = rebalanceMask(data, rule);
  const clamp = (w: number): number => Math.min(maxLeverage, Math.max(-maxLeverage, w));

  let cash = initialCapital;
  let shares = 0;
  const equityCurve = new Array<number>(n + 1);
  equityCurve[0] = initialCapital;
  const timestamps = new Array<number>(n);
  const trades: Trade[] = [];
  let tradedNotional = 0;
  let equitySum = 0;

  for (let i = 0; i < n; i++) {
    const price = data[i]!.close;
    if (!(price > 0)) {
      throw new InputError(`${functionName}: data[${i}].close must be > 0, got ${price}.`, {
        code: ErrorCode.InputNegativeSpot,
        context: { index: i, close: price },
      });
    }
    // Accrue borrow on a short held over the previous bar (priced at the prior close).
    if (i > 0 && shares < 0 && brw.annualRate > 0) {
      cash -= (Math.abs(shares) * data[i - 1]!.close * brw.annualRate) / periodsPerYear;
    }
    if (mask[i]) {
      const j = i - lag;
      if (j >= 0) {
        const targetW = clamp(weightOf(signalValues[j]!));
        const equityNow = cash + shares * price;
        const targetShares = equityNow > 0 ? (targetW * equityNow) / price : 0;
        const d = targetShares - shares;
        // Dust band: skip rebalances whose notional is a vanishing fraction of equity. Without it,
        // holding a constant target weight emits phantom micro-trades because `(w·shares·price)/price`
        // doesn't reproduce `shares` to the last ULP — so buy-and-hold would log spurious turnover.
        const dust = Math.max(1e-9 * equityNow, 1e-9);
        if (Math.abs(d * price) > dust) {
          const side = sideOf(d);
          const fill = slip.fill({ referencePrice: price, side, quantity: Math.abs(d) });
          const commission = fee.commission({ quantity: Math.abs(d), price });
          cash -= d * fill + commission;
          shares = targetShares;
          trades.push({
            symbol,
            timestampMs: data[i]!.timestampMs,
            side,
            quantity: Math.abs(d),
            price: fill,
            commission,
            slippage: Math.abs(d) * Math.abs(fill - price),
            // The vectorized loop trades one share-like series; a unit moves its price in cash.
            multiplier: 1,
          });
          tradedNotional += Math.abs(d) * price;
        }
      }
    }
    const equity = cash + shares * price;
    equityCurve[i + 1] = equity;
    timestamps[i] = data[i]!.timestampMs;
    equitySum += equity;
  }

  const warnings: QuantWarning[] = [...checkDataAlignment(data)];
  if (warmupSkipped > 0) {
    warnings.push({
      code: WarningCode.BacktestSignalWarmup,
      message: `Signal declares ${signalWarmup} warmup bar(s); ${warmupSkipped} non-finite warmup value(s) were traded flat (position 0) rather than rejected.`,
      severity: 'info',
      context: { warmupBars: signalWarmup, skipped: warmupSkipped },
    });
  }
  if (lag === 0) {
    warnings.push({
      code: WarningCode.BacktestLookahead,
      message:
        'executionLag is 0: the signal trades on the same bar it is observed, which look-ahead-biases the result.',
      severity: 'warn',
      context: { executionLag: 0 },
    });
  }
  const averageEquity = equitySum / n;

  const assumptions: BacktestAssumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    initialCapital,
    fill: 'close',
    cost: fee.label,
    slippage: slip.label,
    cashSettlement: 'immediate',
    corporateAction: data[0]!.adjusted ? 'adjusted-prices' : 'none',
    calendar: typeof rule === 'number' ? `every-${rule}-bars` : rule,
    margin: Number.isFinite(maxLeverage) ? 'maxLeverage' : 'unconstrained',
  };
  const diagnostics: ImplementationRisk = {
    warnings,
    benchmarkFixtureVersion: BENCHMARK_FIXTURE_VERSION,
  };

  return {
    points: toEquityPoints(equityCurve, timestamps),
    returns: equityToReturns(equityCurve),
    trades,
    finalValue: equityCurve[n]!,
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
  };
}

/** Per-step simple returns of an equity curve. */
export function equityToReturns(equity: ArrayLike<number>): number[] {
  requireArgumentArray('equityToReturns', 'equity', equity);
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    ensureFinite(equity[i]!, `equity[${i}]`, 'equityToReturns');
    out.push(prev !== 0 ? equity[i]! / prev - 1 : 0);
  }
  return out;
}
