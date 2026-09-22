/**
 * Vectorized signal-composition primitives (spec §16, WS6.4).
 *
 * These are the building blocks a strategy uses to turn indicator series into a `{0,1}`
 * position/signal series that {@link vectorized} can trade. They are the vectorized analogues of the
 * event-driven `crossOver`/`crossUnder` helpers: they operate on whole aligned arrays instead of a
 * single bar's `IndicatorHandle`.
 *
 * **NaN is honest here.** TA batch output is `NaN` during its warmup by design. These primitives
 * *propagate* that NaN rather than fabricate a `0`/`1` from missing data — where either input is NaN
 * (for the cross helpers, at bar `i` or the prior bar `i-1`), the output is `NaN`. Index 0 of a cross
 * series is always `NaN`: a crossing needs a previous bar to compare against. Wrap the result in a
 * {@link SeriesSignal} (`{ value, warmup }`) so {@link vectorized} treats those leading NaNs as a
 * flat (position 0) warmup instead of throwing.
 *
 * **Signal = position, not event.** {@link vectorized} reads the signal as the position to *hold* each
 * bar (`1` = long, `0` = flat), so a signal must stay `1` for every bar you want to be in the trade.
 * {@link gtSeries}/{@link ltSeries} already do this (`1` for the whole regime). The cross helpers do
 * *not*: they fire `1` on the single crossing bar, so feeding one straight in holds the trade for
 * exactly one bar. To trade crossings, latch an entry cross against an exit cross with
 * {@link latchSeries}.
 *
 * @example An SMA-crossover **regime** position fed warmup-safely into the vectorized engine — long for
 * every bar the fast average is above the slow one:
 * ```ts
 * import { sma } from '@insiderfinance/totalfinance/technical-analysis';
 * import { vectorized, gtSeries } from '@insiderfinance/totalfinance/backtest';
 *
 * const closes = candles.map((b) => b.close);
 * const fast = sma.explain(closes, { period: 10 }); // Computed: { value, assumptions, diagnostics }
 * const slow = sma.explain(closes, { period: 30 });
 *
 * // 1 for every bar fast > slow (the whole regime, held), 0 otherwise, NaN through warmup.
 * const position = gtSeries(fast.value, slow.value);
 * // The signal is NaN until BOTH SMAs are warm.
 * const warmup = Math.max(fast.diagnostics.warmup, slow.diagnostics.warmup);
 *
 * // No throw: vectorized treats the leading NaNs as a flat warmup and emits one
 * // `backtest.signal_warmup` info diagnostic.
 * const result = vectorized({ data: candles, signal: { value: position, warmup } });
 * ```
 */

import { ErrorCode, InputError, requireArgumentArray } from '@totalfinance/core';

/**
 * A warmup-aware signal: `{ value, warmup }` hand-built, or any `technicalAnalysis.*.explain(...)` envelope
 * (`{ value, diagnostics: { warmup } }`) — `vectorized` accepts both. `warmup` is the number of
 * leading bars that may be non-finite by design (an indicator's warmup); {@link vectorized} treats
 * a non-finite value at index `i < warmup` as a flat (position 0) bar instead of an error.
 *
 * Defined structurally in this package so `@insiderfinance/totalfinance/backtest` need not depend on `@insiderfinance/totalfinance/technical-analysis`.
 */
export interface SeriesSignal {
  /** Per-bar signal values, aligned to the price bars. */
  value: ArrayLike<number>;
  /** Count of leading bars that may be non-finite by design (the indicator's warmup). */
  warmup: number;
}

/** A TA explain envelope used directly as a signal: warmup rides in `diagnostics.warmup`. */
export interface EnvelopeSignal {
  value: ArrayLike<number>;
  diagnostics: { warmup: number };
}

/** Read `b` at index `i`: a scalar level applies to every bar; a series is indexed. */
function bAt(b: number | ArrayLike<number>, i: number): number {
  return typeof b === 'number' ? b : b[i]!;
}

/** When both inputs are series, require equal length; a length mismatch silently misaligns bars. */
function ensureAligned(
  a: ArrayLike<number>,
  b: number | ArrayLike<number>,
  functionName: string,
): void {
  if (typeof b !== 'number' && !Array.isArray(b) && !ArrayBuffer.isView(b)) {
    throw new InputError(
      `${functionName}: b must be a scalar level or an aligned series, got ${b === null ? 'null' : typeof b}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName } },
    );
  }
  if (typeof b !== 'number' && b.length !== a.length) {
    throw new InputError(
      `${functionName}: series inputs must have equal length (a=${a.length}, b=${b.length}).`,
      { code: ErrorCode.InputOutOfRange, context: { a: a.length, b: b.length } },
    );
  }
}

/**
 * `1` where `a[i] > b[i]`, else `0`; `NaN` where either input is `NaN` at `i` (missing data). `b` may
 * be a scalar level (e.g. `gtSeries(rsi, 70)`) or an aligned series.
 */
export function gtSeries(
  first: ArrayLike<number>,
  second: number | ArrayLike<number>,
): Float64Array {
  requireArgumentArray('gtSeries', 'first', first);
  const functionName = 'gtSeries';
  if (typeof second === 'number' && !Number.isFinite(second)) {
    throw new InputError(
      `${functionName}: a scalar second must be finite — every comparison against NaN is silently false. Received ${String(second)}.`,
      { code: ErrorCode.InputNotFinite, context: { field: 'second' } },
    );
  }
  ensureAligned(first, second, functionName);
  const n = first.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const av = first[i]!;
    const bv = bAt(second, i);
    out[i] = Number.isNaN(av) || Number.isNaN(bv) ? NaN : av > bv ? 1 : 0;
  }
  return out;
}

/**
 * `1` where `a[i] < b[i]`, else `0`; `NaN` where either input is `NaN` at `i` (missing data). `b` may
 * be a scalar level (e.g. `ltSeries(rsi, 30)`) or an aligned series.
 */
export function ltSeries(
  first: ArrayLike<number>,
  second: number | ArrayLike<number>,
): Float64Array {
  requireArgumentArray('ltSeries', 'first', first);
  const functionName = 'ltSeries';
  if (typeof second === 'number' && !Number.isFinite(second)) {
    throw new InputError(
      `${functionName}: a scalar second must be finite — every comparison against NaN is silently false. Received ${String(second)}.`,
      { code: ErrorCode.InputNotFinite, context: { field: 'second' } },
    );
  }
  ensureAligned(first, second, functionName);
  const n = first.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const av = first[i]!;
    const bv = bAt(second, i);
    out[i] = Number.isNaN(av) || Number.isNaN(bv) ? NaN : av < bv ? 1 : 0;
  }
  return out;
}

/**
 * `1` on the bar where `a` crosses from at-or-below `b` to above it (`a[i-1] ≤ b[i-1] && a[i] > b[i]`),
 * else `0`. `NaN` where any of the four inputs (`a`/`b` at `i` or `i-1`) is `NaN`, and at index `0` —
 * a crossing needs a prior bar to compare against. `b` may be a scalar level or an aligned series.
 */
export function crossOverSeries(
  first: ArrayLike<number>,
  second: number | ArrayLike<number>,
): Float64Array {
  requireArgumentArray('crossOverSeries', 'first', first);
  const functionName = 'crossOverSeries';
  if (typeof second === 'number' && !Number.isFinite(second)) {
    throw new InputError(
      `${functionName}: a scalar second must be finite — every comparison against NaN is silently false. Received ${String(second)}.`,
      { code: ErrorCode.InputNotFinite, context: { field: 'second' } },
    );
  }
  ensureAligned(first, second, functionName);
  const n = first.length;
  const out = new Float64Array(n);
  if (n > 0) out[0] = NaN;
  for (let i = 1; i < n; i++) {
    const a0 = first[i - 1]!;
    const a1 = first[i]!;
    const b0 = bAt(second, i - 1);
    const b1 = bAt(second, i);
    if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) {
      out[i] = NaN;
    } else {
      out[i] = a0 <= b0 && a1 > b1 ? 1 : 0;
    }
  }
  return out;
}

/**
 * `1` on the bar where `a` crosses from at-or-above `b` to below it (`a[i-1] ≥ b[i-1] && a[i] < b[i]`),
 * else `0`. `NaN` where any of the four inputs (`a`/`b` at `i` or `i-1`) is `NaN`, and at index `0` —
 * a crossing needs a prior bar to compare against. `b` may be a scalar level or an aligned series.
 */
export function crossUnderSeries(
  first: ArrayLike<number>,
  second: number | ArrayLike<number>,
): Float64Array {
  requireArgumentArray('crossUnderSeries', 'first', first);
  const functionName = 'crossUnderSeries';
  if (typeof second === 'number' && !Number.isFinite(second)) {
    throw new InputError(
      `${functionName}: a scalar second must be finite — every comparison against NaN is silently false. Received ${String(second)}.`,
      { code: ErrorCode.InputNotFinite, context: { field: 'second' } },
    );
  }
  ensureAligned(first, second, functionName);
  const n = first.length;
  const out = new Float64Array(n);
  if (n > 0) out[0] = NaN;
  for (let i = 1; i < n; i++) {
    const a0 = first[i - 1]!;
    const a1 = first[i]!;
    const b0 = bAt(second, i - 1);
    const b1 = bAt(second, i);
    if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) {
      out[i] = NaN;
    } else {
      out[i] = a0 >= b0 && a1 < b1 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Turn discrete **entry/exit events** into a held `{0,1}` **position** series: latch to `1` on an entry
 * event and hold it until an exit event flips it back to `0`. This is the bridge from the cross helpers
 * — which fire `1` on a *single* bar — to a position {@link vectorized} can trade. Feeding a raw
 * {@link crossOverSeries} in as a signal is the classic silent bug: it opens the trade the bar of the
 * cross and *closes it the very next bar*, because every non-crossing bar is `0`. Latch the two crosses
 * together instead (enter on cross-over, exit on cross-under) to hold the trade between them.
 *
 * Any non-zero, finite value in `entries`/`exits` counts as a fire (so `crossOverSeries`/`gtSeries`
 * outputs drop straight in). `NaN` in either input at bar `i` is warmup: the output is `NaN` and the
 * latch is left untouched, matching how the other primitives propagate an indicator's warmup. When an
 * entry and an exit fire on the same bar the **exit wins** (`0`), so a same-bar whipsaw never leaves a
 * phantom position open.
 *
 * @example Enter long on a 10/30 SMA golden cross, exit on the death cross, hold in between:
 * ```ts
 * const entries = crossOverSeries(fast.value, slow.value);
 * const exits = crossUnderSeries(fast.value, slow.value);
 * const position = latchSeries(entries, exits); // 1 held from golden cross until death cross
 * const warmup = Math.max(fast.diagnostics.warmup, slow.diagnostics.warmup) + 1;
 * vectorized({ data: candles, signal: { value: position, warmup } });
 * ```
 */
export function latchSeries(entries: ArrayLike<number>, exits: ArrayLike<number>): Float64Array {
  requireArgumentArray('latchSeries', 'entries', entries);
  requireArgumentArray('latchSeries', 'exits', exits);
  if (entries.length !== exits.length) {
    throw new InputError(
      `latchSeries: entries and exits must have equal length (entries=${entries.length}, exits=${exits.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { entries: entries.length, exits: exits.length },
      },
    );
  }
  const n = entries.length;
  const out = new Float64Array(n);
  let held = 0; // latched position, carried across finite bars
  for (let i = 0; i < n; i++) {
    const e = entries[i]!;
    const x = exits[i]!;
    if (Number.isNaN(e) || Number.isNaN(x)) {
      out[i] = NaN; // warmup — do not disturb the latch
      continue;
    }
    if (x)
      held = 0; // exit wins a same-bar tie
    else if (e) held = 1;
    out[i] = held;
  }
  return out;
}
