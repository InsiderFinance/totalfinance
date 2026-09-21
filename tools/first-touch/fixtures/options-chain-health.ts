/** Standalone shard: main integrates this map into fixtures.ts and the public manifest. */
import { resolvedExpiry } from '@totalfinance/core';
import type { OptionChainHealthInput } from '@totalfinance/options';

/** Fresh, independently specified ATM premium, not manufactured from the implementation's model. */
export const OPTION_CHAIN_HEALTH_FIXTURES: Record<string, () => unknown[]> = {
  'options.optionChainHealth': () => {
    const expiry = '2027-01-01T00:00:00Z';
    const input: OptionChainHealthInput = {
      quotes: [
        {
          contract: {
            underlying: 'X',
            style: 'european',
            type: 'call',
            strike: 100,
            expiry,
            ...resolvedExpiry(expiry),
          },
          timestampMs: 1767225600000,
          bid: 7.9,
          ask: 8.1,
        },
      ],
      market: {
        underlying: 'X',
        spot: 100,
        asOf: '2026-01-01T00:00:00Z',
        riskFreeRate: 0,
        dividendYield: 0,
      },
      config: {
        model: 'black-scholes-merton',
        priceSource: 'mid',
        maximumQuoteAgeMs: 60_000,
        maximumRelativeSpread: 0.1,
      },
    };
    return [input];
  },
  'totalfinance.options.optionChainHealth': () => {
    // The same callable's no-model branch: no fake rate, yield, or spot for quote-only work.
    const args = OPTION_CHAIN_HEALTH_FIXTURES['options.optionChainHealth']!();
    const source = args[0] as OptionChainHealthInput;
    const input: OptionChainHealthInput = {
      quotes: source.quotes,
      market: { underlying: 'X', asOf: 1767225600000 },
      config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
    };
    return [input];
  },
};
