import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionTrade, OptionType } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';

const expiry = '2026-03-20';
function mk(
  strike: number,
  ts: number,
  price: number,
  size: number,
  bid: number,
  ask: number,
  extra: { exchange?: string; type?: OptionType } = {},
): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type: extra.type ?? 'call',
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
      multiplier: 100,
    },
    timestampMs: ts,
    price,
    size,
    bid,
    ask,
    ...(extra.exchange !== undefined ? { exchange: extra.exchange } : {}),
  };
}

/**
 * Regression for two external-review findings:
 *  - venue verification was GLOBAL: one unrelated print carrying an exchange suppressed the
 *    not-venue-verified warning for every timing-only sweep;
 *  - an `unknown` aggressor was counted as a BUY in a spread's net premium.
 */
describe('flow — no fabricated venue verification / directional premium', () => {
  it('a timing-only sweep still warns even when an unrelated print carries an exchange', () => {
    const trades: OptionTrade[] = [
      // three same-contract prints at the ask (→ buy), no exchange ⇒ a timing-only sweep
      mk(100, 1000, 5.1, 10, 4.9, 5.1),
      mk(100, 1100, 5.1, 15, 4.9, 5.1),
      mk(100, 1200, 5.1, 20, 4.9, 5.1),
      // one unrelated print that DOES carry an exchange (a different contract)
      mk(300, 5000, 1.0, 5, 0.9, 1.1, { exchange: 'CBOE' }),
    ];
    const fa = flow(trades);
    expect(fa.sweeps.some((s) => !s.venueVerified)).toBe(true);
    // the stray exchange print must NOT suppress the per-sweep warning (the review bug)
    expect(fa.diagnostics.warnings.some((w) => w.code === 'flow.sweeps_not_venue_verified')).toBe(
      true,
    );
  });

  it('an unknown-aggressor spread leg is excluded from net premium, not counted as a buy', () => {
    const trades: OptionTrade[] = [
      mk(100, 1000, 5.1, 10, 4.9, 5.1), // at the ask → buy (+5.1)
      mk(110, 1000, 3.0, 10, 2.9, 3.1), // at the mid → unknown (must contribute 0, not +3.0)
    ];
    const fa = flow(trades, { spreadWindowMs: 100 });
    expect(fa.spreads.length).toBeGreaterThan(0);
    const spread = fa.spreads[0]!;
    expect(spread.directionKnown).toBe(false);
    // only the buy leg contributes: 5.1 × 10 × 100 = 5100. If the unknown leg were counted as a buy
    // (the old bug) it would be 5100 + 3000 = 8100.
    expect(spread.netPremium).toBeCloseTo(5100, 6);
  });
});
