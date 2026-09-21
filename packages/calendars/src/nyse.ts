/**
 * `@totalfinance/calendars/nyse` — the New York Stock Exchange trading calendar.
 *
 * Built from the shared US-equity builder (`usEquityMarketCalendar`) that Cboe also uses: NYSE and
 * Cboe observe the same schedule, so one definition serves both and a fix can never land on one
 * calendar and miss the other. This entrypoint still exports its own `NYSE` instance, with its own
 * `name` and its own per-year caches.
 */

import { type TradingCalendar } from './trading-calendar.js';
import { usEquityMarketCalendar } from './us-market.js';

export const NYSE: TradingCalendar = usEquityMarketCalendar('NYSE');
