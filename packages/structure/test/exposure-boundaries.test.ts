import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { isQuantError } from '@totalfinance/core';
import { exposure } from '@totalfinance/structure';

/**
 * Regressions for external-review findings on exposure boundaries:
 *  - infinite spot/IV slipped past `> 0` guards (Infinity > 0 is true) and poisoned the aggregate;
 *  - scenario grids were unvalidated (NaN/0-step grids produced junk cells);
 *  - max pain aggregated UNRELATED expiries even though it is an expiry-specific quantity.
 */
const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const market = { riskFreeRate: rate, asOf, spot };
const config = { convention: 'callsPositivePutsNegative' as const };

function q(
  type: OptionType,
  strike: number,
  oi: number,
  expiry: string,
  impliedVolatility: number | undefined = 0.2,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      multiplier: 100,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    ...(impliedVolatility === undefined ? {} : { impliedVolatility }),
    openInterest: oi,
    underlyingPrice: spot,
  };
}

describe('exposure — infinite boundary inputs', () => {
  it('rejects an infinite spot (Infinity > 0 is not a valid spot)', () => {
    let caught: unknown;
    try {
      exposure({
        quotes: [q('call', 100, 1000, '2026-02-20')],
        market: { riskFreeRate: rate, asOf, spot: Infinity },
        config,
      });
    } catch (e) {
      caught = e;
    }
    // The boundary ladder now catches this with the four-code taxonomy's SPECIFIC code
    // (`input.not_finite`) instead of letting Infinity travel to the positivity check
    // (`input.out_of_range`) — the old pin recorded the longer journey, not a contract.
    expect(isQuantError(caught, 'input.not_finite')).toBe(true);
  });

  it('does not price off an infinite IV — the aggregate stays finite', () => {
    const prof = exposure({
      quotes: [
        q('call', 100, 1000, '2026-02-20'),
        q('put', 95, 800, '2026-02-20'),
        q('call', 110, 500, '2026-02-20', Infinity), // ∞ IV ⇒ skipped, must not poison the book
      ],
      market,
      config,
    });
    expect(Number.isFinite(prof.aggregate.gex)).toBe(true);
    expect(Number.isFinite(prof.aggregate.dex)).toBe(true);
  });
});

describe('exposure.scenarioMap — grid validation', () => {
  const prof = exposure({
    quotes: [q('call', 100, 1000, '2026-02-20')],
    market,
    config,
  });

  it('rejects a zero-step grid', () => {
    expect(() => prof.scenarioMap({ spot: { from: 90, to: 110, steps: 0 } })).toThrow(
      /steps must be an integer/,
    );
  });

  it('rejects a non-finite explicit grid entry', () => {
    let caught: unknown;
    try {
      prof.scenarioMap({ spot: [95, NaN, 105] });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });

  it('rejects a non-finite vol shock', () => {
    expect(() => prof.scenarioMap({ volatilityShock: [0, Infinity] })).toThrow();
  });
});

describe('exposure — max pain is expiry-specific', () => {
  // NEAR expiry (2026-02-20): puts@90/100 + calls@100/110 ⇒ payout is minimized at S=100.
  // FAR expiry (2026-06-19): a huge deep-ITM put@130 that, if the expiries were pooled, would drag the
  // combined max-pain strike out to 130. Max pain must report the NEAR expiry's 100, not the pooled 130.
  const near = '2026-02-20';
  const far = '2026-06-19';
  const quotes: OptionQuote[] = [
    q('put', 90, 100, near),
    q('put', 100, 100, near),
    q('call', 100, 100, near),
    q('call', 110, 100, near),
    q('put', 130, 10_000, far), // deep ITM at spot 100; dominates a pooled calculation
  ];

  it('scopes max pain to the nearest expiry (does not pool unrelated expiries)', () => {
    const prof = exposure({ quotes, market, config });
    expect(prof.levels().maxPain).toBe(100);
  });
});

/**
 * A CUSTOM SIGN CONVENTION IS A CHOICE OF DIRECTION, AND THE DOMAIN IS ENFORCED.
 *
 * `ExposureConvention`'s object arm declares `{ calls: 1 | -1; puts: 1 | -1 }` and `resolveSigns`
 * passed both fields straight through. Nothing checked them, and `ensureKnownKeys` guards `config`'s
 * own keys without descending into this nested object, so every one of these was accepted:
 * `{ calls: 0, puts: 999 }` reported a gamma exposure of zero, `{ calls: 7, puts: -3 }` reported one
 * seven times too large — converged, unwarned, and echoed back in `assumptions.convention` as if it
 * had been resolved — and `{}` produced NaN. A wrong number that looks like an answer is the worst
 * failure this library can have.
 */
describe('a custom exposure convention must declare a direction, not a magnitude', () => {
  const quotes = [q('call', 100, 1000, '2026-06-19')];

  const run = (convention: unknown) =>
    exposure({
      quotes,
      market,
      config: { convention: convention as never },
    });

  it('accepts the two declared directions', () => {
    expect(run({ calls: 1, puts: -1 }).aggregate.gex).toBeGreaterThan(0);
    expect(run({ calls: -1, puts: 1 }).aggregate.gex).toBeLessThan(0);
  });

  it('rejects a magnitude that would silently rescale every exposure', () => {
    for (const convention of [
      { calls: 7, puts: -3 },
      { calls: 0, puts: 999 },
      { calls: 2, puts: -1 },
      { calls: 1, puts: -0.5 },
    ]) {
      expect(() => run(convention), JSON.stringify(convention)).toThrow(/must be 1 or -1/);
    }
  });

  it('rejects a missing or non-numeric side rather than computing NaN', () => {
    for (const convention of [{}, { calls: 1 }, { puts: -1 }, { calls: 'a', puts: 1 }]) {
      expect(() => run(convention), JSON.stringify(convention)).toThrow(/must be 1 or -1/);
    }
  });

  it('rejects an unknown field inside the convention (Law 12, one level down)', () => {
    expect(() => run({ calls: 1, puts: -1, extra: 5 })).toThrow(/unknown field "extra"/);
  });

  it('throws the typed error, not a bare TypeError', () => {
    try {
      run({ calls: 7, puts: -3 });
      expect.unreachable('accepted an out-of-domain sign');
    } catch (error) {
      expect(isQuantError(error)).toBe(true);
    }
  });
});
