import { describe, expect, it } from 'vitest';
import { NYSE, crypto24x7, tradingDaysToExpiry } from '@totalfinance/calendars';

/**
 * P3.6 — `tradingDaysToExpiry`: sessions remaining in `(from, expiry]` on the calendar's actual
 * schedule (the number traders scale vol with), never calendar-days arithmetic.
 */
describe('calendars.tradingDaysToExpiry', () => {
  it('counts NYSE sessions excluding from, including a trading-day expiry', () => {
    // Mon 2026-09-14 → Fri 2026-09-18: Tue+Wed+Thu+Fri = 4 sessions (no holidays that week).
    expect(tradingDaysToExpiry(NYSE, '2026-09-14', '2026-09-18')).toBe(4);
  });

  it('same-day expiry is 0 and weekends contribute nothing', () => {
    expect(tradingDaysToExpiry(NYSE, '2026-09-18', '2026-09-18')).toBe(0);
    // Fri → Mon: only Monday counts.
    expect(tradingDaysToExpiry(NYSE, '2026-09-18', '2026-09-21')).toBe(1);
  });

  it('holidays are excluded from the count', () => {
    // Thanksgiving 2026 is Thu 2026-11-26: Mon..Fri that week has 4 sessions after Monday…
    const withHoliday = tradingDaysToExpiry(NYSE, '2026-11-23', '2026-11-27');
    // Tue, Wed, Fri count; Thu (holiday) does not.
    expect(withHoliday).toBe(3);
  });

  it('a 24/7 crypto calendar counts every day', () => {
    expect(tradingDaysToExpiry(crypto24x7, '2026-09-14', '2026-09-21')).toBe(7);
  });

  it('an expiry before from is a typed error, never a negative count', () => {
    expect(() => tradingDaysToExpiry(NYSE, '2026-09-18', '2026-09-14')).toThrow(/before/);
  });
});
