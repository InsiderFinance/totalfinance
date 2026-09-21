/**
 * `@totalfinance/calendars` — exchange trading calendars built on the `@totalfinance/core` rules engine.
 *
 * Prefer the deep entrypoints (`@totalfinance/calendars/nyse`, `/cboe`, `/crypto`) so you only bundle the
 * calendar you use. This aggregate entrypoint re-exports them for convenience.
 */

export { NYSE } from './nyse.js';
export { CBOE } from './cboe.js';
export { crypto24x7 } from './crypto.js';
export { withTradingVocabulary, requireCalendar } from './trading-calendar.js';
export type { TradingCalendar } from './trading-calendar.js';
// 3B.2 nameability: four public heads here take a `Calendar` — a consumer of THIS package must
// be able to name that parameter without installing @totalfinance/core alongside it.
export type { Calendar } from '@totalfinance/core';
export { expirations, nextExpiry, tradingDaysToExpiry } from './expirations.js';
export type { ExpirationKind } from './expirations.js';
export {
  CALENDAR_DATA_VERSION,
  usMarketHolidayRules,
  usMarketHalfDayRules,
  usMarketClosures,
} from './us-market.js';
