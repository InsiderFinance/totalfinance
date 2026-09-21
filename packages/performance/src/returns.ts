import { ErrorCode, InputError, requireArgumentArray } from '@totalfinance/core';
/** Return calculations (spec §15.1). */

/**
 * Throw the shared "a zero level cannot be a return denominator" error. `field` is the name the
 * CALLER typed (`prices` here, `equity` in `analyze({ equity })`, which runs the same check under
 * its own name), so the message teaches against the actual call site rather than an internal one.
 * Deliberately module-private: this is a guard, not a public API surface.
 */
function requireNonZeroLevels(
  levels: ArrayLike<number>,
  functionName: string,
  field: string,
): void {
  // Only a level that is USED as a denominator matters: a series ending at 0 is a legitimate total
  // loss (a −100% final return), while a 0 anywhere before the end makes that period's return
  // `x/0` — an undefined quantity this used to emit as a silent NaN, which then surfaced hundreds
  // of lines away as an error blaming `annualizedReturn`.
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i] === 0) {
      throw new InputError(
        `${functionName}: ${field}[${i}] is 0 — the return over ${field}[${i}] → ${field}[${i + 1}] divides by it and is undefined. ${field} is a price/equity LEVEL series (e.g. [100, 110, 99]); drop the zero level or pass the per-period returns directly.`,
        { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, index: i } },
      );
    }
  }
}

/**
 * Simple period-over-period returns; output length is `prices.length - 1`. A zero price before the
 * final observation throws (that period's return divides by zero) rather than emitting a NaN that
 * poisons every downstream metric.
 */
export function simpleReturns(prices: ArrayLike<number>): number[] {
  requireArgumentArray('simpleReturns', 'prices', prices);
  requireNonZeroLevels(prices, 'simpleReturns', 'prices');
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    out.push((prices[i]! - prev) / prev);
  }
  return out;
}

/** Continuously-compounded (log) returns; output length is `prices.length - 1`. */
export function logReturns(prices: ArrayLike<number>): number[] {
  requireArgumentArray('logReturns', 'prices', prices);
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i]! / prices[i - 1]!));
  return out;
}

/** Cumulative compounded return at each step from a series of simple returns. */
export function cumulativeReturns(returns: ArrayLike<number>): number[] {
  requireArgumentArray('cumulativeReturns', 'returns', returns);
  const out: number[] = [];
  let growth = 1;
  for (let i = 0; i < returns.length; i++) {
    growth *= 1 + returns[i]!;
    out.push(growth - 1);
  }
  return out;
}

/**
 * Equity curve (growth of `start`) from a series of simple returns. The curve begins at `start` and
 * has length `returns.length + 1`, so `analyze({ equity: equityCurve(returns) })` recovers every
 * return — the starting capital is the first point, not an implicit one. (`equityCurve([])` is
 * `[start]`.)
 */
export function equityCurve(returns: ArrayLike<number>, start = 1): number[] {
  requireArgumentArray('equityCurve', 'returns', returns);
  const out: number[] = [start];
  let value = start;
  for (let i = 0; i < returns.length; i++) {
    value *= 1 + returns[i]!;
    out.push(value);
  }
  return out;
}
