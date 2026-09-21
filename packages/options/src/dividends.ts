/**
 * Discrete-dividend handling shared by every engine (BSM/pro and the American engines), so the
 * `market.dividends` field is never silently ignored on one path while honored on another.
 *
 * EX-DATE CONVENTION: a date-only `exDate` resolves to the US equity market OPEN (09:30
 * America/New_York) — the instant the share stops carrying the dividend — NOT the 16:00 ET
 * option-expiry convention. See {@link parseExDateToEpoch}. A zoned datetime `exDate` is the
 * caller's explicit instant.
 */

import { type EpochMs, ErrorCode, InputError } from '@totalfinance/core';
import { timeToExDateYears } from './time.js';
import type { OptionMarket } from './types.js';

/** Named state needed to apply the escrowed-dividend approximation. */
export interface EscrowedSpotInput {
  spot: number;
  market: OptionMarket;
  asOf: EpochMs;
  timeToExpiryYears: number;
  riskFreeRate: number;
  functionName: string;
}

/** Whether the market carries a discrete cash-dividend schedule. */
export function hasDiscreteDividends(market: OptionMarket): boolean {
  return !!(market.dividends && market.dividends.length > 0);
}

/**
 * Escrowed-dividend spot: the spot reduced by the present value of cash dividends with an ex-date
 * strictly before expiry. This is the documented approximation used uniformly across engines for
 * discrete dividends; continuous `dividendYield` is applied separately by each model.
 *
 * Each dividend amount must be finite and non-negative, and the resulting escrowed spot must stay
 * positive — otherwise this throws a typed {@link InputError}. A pricer must never return a `NaN`
 * value with `converged: true` (design law #4), so a malformed or spot-exceeding dividend schedule
 * is rejected here rather than silently producing `NaN` downstream.
 */
export function escrowedSpot(input: EscrowedSpotInput): number {
  const {
    spot,
    market,
    asOf,
    timeToExpiryYears: horizonYears,
    riskFreeRate,
    functionName: fn,
  } = input;
  if (!hasDiscreteDividends(market)) return spot;
  let pv = 0;
  for (const div of market.dividends!) {
    if (!Number.isFinite(div.amount) || div.amount < 0) {
      throw new InputError(
        `${fn}: dividend amount must be a finite, non-negative number, got ${div.amount}.`,
        { code: ErrorCode.InputOutOfRange, context: { exDate: div.exDate, amount: div.amount } },
      );
    }
    // Ex-dates resolve at the market OPEN (09:30 ET): once the ex-date session has started the
    // dividend is already out of the spot, so `t <= 0` correctly drops it instead of escrowing it
    // a second time out of an intraday spot.
    const t = timeToExDateYears(asOf, div.exDate, fn);
    if (t > 0 && t < horizonYears) pv += div.amount * Math.exp(-riskFreeRate * t);
  }
  const escrowed = spot - pv;
  if (!(escrowed > 0)) {
    throw new InputError(
      `${fn}: present value of discrete dividends (${pv}) is not less than the spot (${spot}); the escrowed spot would be non-positive.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { spot, dividendPresentValue: pv, escrowedSpot: escrowed },
      },
    );
  }
  return escrowed;
}
