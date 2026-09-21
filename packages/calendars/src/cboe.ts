/**
 * `@totalfinance/calendars/cboe` — Cboe options trading calendar.
 *
 * Cboe observes the same US market holiday schedule as NYSE; session hours are expressed in ET
 * (09:30–16:00) to match how equity-option hours are quoted. Both venues come from the one shared
 * US-equity builder (`usEquityMarketCalendar`), so a schedule fix can never land on one calendar
 * and miss the other — each still gets its own instance, `name`, and per-year caches.
 *
 * LIMITATION (WS3.9): this models EQUITY-option regular hours only. It does NOT encode the 16:15 ET
 * close for cash-settled index options (SPX/VIX), nor Cboe Global Trading Hours (GTH, the overnight
 * session). Callers pricing index options or GTH activity must adjust the session accordingly.
 */

import { type TradingCalendar } from './trading-calendar.js';
import { usEquityMarketCalendar } from './us-market.js';

export const CBOE: TradingCalendar = usEquityMarketCalendar('CBOE');
