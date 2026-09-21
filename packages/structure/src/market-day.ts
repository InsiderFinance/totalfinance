/**
 * The US options market's calendar DAY (America/New_York), shared by the exposure and flow 0DTE
 * classifications. Internal to `@totalfinance/structure` (not part of the package surface).
 *
 * Expiries resolve to 16:00 ET (`optionExpiryToMs`), which is 20:00/21:00 **UTC** — so a UTC-day
 * comparison is not the trading day. Between 20:00 and 23:59 ET the UTC date is already TOMORROW:
 * a Thursday 21:30 ET snapshot classified a *Friday* expiry as 0DTE (same UTC day), and the reverse
 * error moves an OPEX Friday out of the weekly bucket. Both are "expires today" flags on a dashboard,
 * so the day boundary has to be the one the market keeps.
 *
 * Pure and clock-free: it reads only the timestamps handed to it (`Intl` supplies the zone offset,
 * including DST, without a `Date.now()` anywhere).
 */

import { usEquityMarketDateUtcMs, usEquityMarketDayIndex } from '@totalfinance/core';

const MS_PER_DAY = 86_400_000;

/**
 * The market-calendar day an instant falls on, as a whole-day index — core's ONE America/New_York
 * day boundary (`usEquityMarketDayIndex`), re-exported for the exposure and flow classifications.
 */
export function marketDayIndex(epochMs: number): number {
  return usEquityMarketDayIndex(epochMs);
}

/** UTC-midnight epoch of the market DATE an instant falls on (core's `usEquityMarketDateUtcMs`). */
export function marketDateUtcMs(epochMs: number): number {
  return usEquityMarketDateUtcMs(epochMs);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The market day of an `asOf` **as the caller expressed it**. Exposure resolves `asOf` through the
 * valuation-instant door, so it is a real instant (epoch ms or a zoned datetime) and maps to the ET
 * date it falls on. The date-only branch is kept for callers that pass a trading DATE literally: it
 * must not be re-zoned (UTC midnight is 19:00/20:00 ET on the PREVIOUS day, which would turn
 * `'2026-06-19'` into June 18 and un-flag every Friday 0DTE contract).
 */
export function asOfMarketDayIndex(asOf: number | string, resolvedMs: number): number {
  if (typeof asOf === 'string') {
    const m = DATE_ONLY.exec(asOf);
    if (m) return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
  }
  return marketDayIndex(resolvedMs);
}
