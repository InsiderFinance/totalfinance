/**
 * WS1.14: flow's 0DTE check uses the canonical `optionExpiryToMs` (date-only ⇒ 16:00 ET) and throws
 * on an unparseable expiry rather than silently returning false.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it, vi } from 'vitest';
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

describe('flow 0DTE classification cost', () => {
  it('classifies a session of prints with a handful of calendar reads, not two per print', async () => {
    // Prints every 0.47 s through a 2033 session on four expiries, including the day's own.
    const open = Date.UTC(2033, 5, 1, 13, 30);
    const expiries = ['2033-06-01', '2033-06-03', '2033-06-17', '2033-09-16'];
    const trades = Array.from({ length: 10_000 }, (_, i) =>
      tradeWithExpiry(expiries[i % expiries.length]!, open + i * 470),
    );
    // Fresh modules, so no other test's calendar reads are already remembered.
    vi.resetModules();
    const fresh = await import('@totalfinance/structure');
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    let analysis: ReturnType<typeof flow>;
    try {
      analysis = fresh.flow(trades);
      // One read per expiry label (its 16:00 ET close), then three per UTC hour (two hours of prints,
      // four expiry instants): the hour's first instant exactly, then its two ends. Not two per print.
      const hours = 2 + expiries.length;
      expect(formatToParts.mock.calls.length).toBeLessThanOrEqual(expiries.length + 3 * hours);
    } finally {
      formatToParts.mockRestore();
    }
    // The classification itself is unchanged: exactly the prints on the 1 June expiry are 0DTE.
    expect(analysis.zeroDaysToExpiry).toHaveLength(trades.length / expiries.length);
    expect(
      analysis.trades.every(
        (trade) => trade.isZeroDaysToExpiry === (trade.expiry === '2033-06-01'),
      ),
    ).toBe(true);
  });
});
