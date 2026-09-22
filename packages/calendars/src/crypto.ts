/**
 * `@insiderfinance/totalfinance/calendars/crypto` — a 24/7 crypto trading calendar.
 *
 * Crypto trades continuously — no weekends, no holidays — which is EXACTLY core's `alwaysOpen`
 * calendar. So this entrypoint ALIASES `alwaysOpen` (a single implementation, WS3.9) instead of
 * duplicating a rule calendar. Aliasing also keeps the crypto module graph free of `us-market.js`
 * (the exchange holiday dataset): importing `@insiderfinance/totalfinance/calendars/crypto` never pulls equity-holiday
 * data. Its `session` is `00:00`–`24:00` (`24:00` is the "no close" sentinel; see `createRuleCalendar`).
 *
 * For an FX-style calendar — closed on weekends, open 24h on weekdays — use core's `weekendsOnly`.
 */

import { alwaysOpen } from '@totalfinance/core';
import { type TradingCalendar, withTradingVocabulary } from './trading-calendar.js';

/** The 24×7 crypto calendar with trader vocabulary (R10). */
export const crypto24x7: TradingCalendar = withTradingVocabulary(alwaysOpen);
