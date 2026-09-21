/**
 * WS1.14: flow's 0DTE check uses the canonical `optionExpiryToMs` (date-only ⇒ 16:00 ET) and throws
 * on an unparseable expiry rather than silently returning false.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionTrade } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';

function tradeWithExpiry(expiry: string, ts: number): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type: 'call',
      style: 'european',
      strike: 100,
      expiry,
      ...resolvedExpiry(expiry),
      multiplier: 100,
    },
    timestampMs: ts,
    price: 5,
    size: 1,
    bid: 4.9,
    ask: 5.1,
  };
}

describe('flow 0DTE classification (WS1.14)', () => {
  it('a same-day print (14:00 ET) on a date-only expiry classifies as 0DTE', () => {
    const expiry = '2026-06-19'; // Friday
    const ts = Date.UTC(2026, 5, 19, 18); // 18:00 UTC = 14:00 ET (EDT) on the expiry day
    const f = flow([tradeWithExpiry(expiry, ts)]);
    expect(f.trades[0]!.isZeroDaysToExpiry).toBe(true);
    expect(f.zeroDaysToExpiry).toHaveLength(1);
  });

  it('a print on a different calendar day is not 0DTE', () => {
    const f = flow([tradeWithExpiry('2026-06-19', Date.UTC(2026, 5, 18, 18))]);
    expect(f.trades[0]!.isZeroDaysToExpiry).toBe(false);
  });

  it('an unparseable expiry throws rather than silently returning false', () => {
    expect(() => flow([tradeWithExpiry('2026-13-45', Date.UTC(2026, 5, 19, 18))])).toThrow();
  });
});
