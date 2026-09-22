/**
 * `@insiderfinance/totalfinance/calendars` — exchange trading calendars built on the `@insiderfinance/totalfinance/core` rules engine.
 *
 * Prefer the deep entrypoints (`@insiderfinance/totalfinance/calendars/nyse`, `/cboe`, `/crypto`) so you only bundle the
 * calendar you use. This aggregate entrypoint re-exports them for convenience.
 */

export { NYSE } from './nyse.js';
export { CBOE } from './cboe.js';
export { crypto24x7 } from './crypto.js';
export { withTradingVocabulary, requireCalendar } from './trading-calendar.js';
export type { TradingCalendar } from './trading-calendar.js';
// 3B.2 nameability: four public heads here take a `Calendar` — a consumer of THIS package must
// be able to name that parameter from the same calendar entry point without another import.
export type { Calendar } from '@totalfinance/core';
export { expirations, nextExpiry, tradingDaysToExpiry } from './expirations.js';
export type { ExpirationKind } from './expirations.js';
export {
  CALENDAR_DATA_VERSION,
  usMarketHolidayRules,
  usMarketHalfDayRules,
  usMarketClosures,
} from './us-market.js';
