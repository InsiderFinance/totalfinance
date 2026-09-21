import { describe, expect, it } from 'vitest';
import { alwaysOpen } from '@totalfinance/core';
import { requireCalendar, withTradingVocabulary } from '@totalfinance/calendars';

describe('structural calendar boundaries', () => {
  it('accepts metadata decoration and preserves it through trader vocabulary', () => {
    const decorated = { ...alwaysOpen, venueId: 'CRYPTO-24X7' };
    expect(requireCalendar('test', decorated)).toBe(decorated);
    expect(withTradingVocabulary(decorated)).toMatchObject({ venueId: 'CRYPTO-24X7' });
  });

  it('rejects partial objects instead of promising an unusable Calendar', () => {
    const partial = { ...alwaysOpen, session: undefined };
    expect(() => requireCalendar('test', partial)).toThrow(/calendar.session must be a function/);
  });
});
