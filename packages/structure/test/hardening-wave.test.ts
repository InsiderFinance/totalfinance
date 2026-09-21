/**
 * The 2026-08 defect-fix wave for `@totalfinance/structure` — one regression per reviewed finding.
 *
 * Each test FAILS on the pre-fix code: a call wall that pointed at the EMPTIEST strike under any
 * dealer-negative convention, a per-tick path that turned a bad print into a NaN exposure in silence,
 * two option bags with no unknown-key guard, a `speed` matching no convention, results that were
 * frozen row-by-row but not in aggregate, a 0DTE flag that used the UTC day (so it fired on the wrong
 * session for four hours every evening), and an aggressor rule that called itself Lee–Ready.
 */

import { describe, expect, it } from 'vitest';
import {
  InputError,
  type OptionQuote,
  type OptionTrade,
  type OptionType,
  resolvedExpiry,
} from '@totalfinance/core';
import { type ExposureConvention, type Levels, exposure, flow } from '@totalfinance/structure';

const RATE = 0.03;
const SPOT = 100;
const AS_OF = Date.UTC(2026, 0, 2, 15); // 10:00 ET, a normal session
const EXPIRY = '2026-03-20';

function quote(
  type: OptionType,
  strike: number,
  openInterest: number,
  expiry = EXPIRY,
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
    timestampMs: AS_OF,
    impliedVolatility: 0.22,
    openInterest,
    underlyingPrice: SPOT,
  };
}

/** A realistic two-sided chain: puts heavy below spot, calls heavy above. */
function chain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (let K = 80; K <= 120; K += 5) {
    rows.push(quote('call', K, 300 + Math.max(0, K - 100) * 40));
    rows.push(quote('put', K, 300 + Math.max(0, 100 - K) * 40));
  }
  return rows;
}

function profileWith(convention: ExposureConvention, quotes: OptionQuote[] = chain()) {
  return exposure({
    quotes,
    market: { spot: SPOT, riskFreeRate: RATE, asOf: AS_OF },
    config: { convention },
  });
}

// ───────────────── 13. walls are MAGNITUDES, not signed extremes ─────────────────

describe('callWall is the strike with the most call gamma, under every convention', () => {
  it('the 10-lot vs 10,000-lot repro: dealerShortGamma picks the 10,000-lot strike', () => {
    // Under dealerShortGamma every call GEX is ≤ 0, so a SIGNED max returned the least-negative
    // strike — the 10-lot — and the dashboard drew resistance where there was almost no gamma.
    const quotes = [quote('call', 105, 10), quote('call', 110, 10_000)];
    const levels = profileWith('dealerShortGamma', quotes).levels();
    expect(levels.callWall).toBe(110);
    // The naive convention (calls +) always agreed; it must still.
    expect(profileWith('callsPositivePutsNegative', quotes).levels().callWall).toBe(110);
    // …and a custom calls:-1 convention behaves like dealerShortGamma, not like the bug.
    expect(profileWith({ calls: -1, puts: 1 }, quotes).levels().callWall).toBe(110);
  });

  it('callWall and putWall are symmetric in construction', () => {
    const puts = [quote('put', 95, 10), quote('put', 90, 10_000)];
    expect(profileWith('dealerShortGamma', puts).levels().putWall).toBe(90);
    expect(profileWith('callsPositivePutsNegative', puts).levels().putWall).toBe(90);
  });
});

describe('convention sign-flip property', () => {
  // A global sign flip: every position sign negated, nothing else changed.
  const positive = profileWith('callsPositivePutsNegative'); // calls +1, puts −1
  const flipped = profileWith({ calls: -1, puts: 1 });
  const a = positive.levels();
  const b = flipped.levels();

  it('LOCATIONS are invariant — a wall does not move because the convention changed sign', () => {
    const locations: Array<keyof Levels> = [
      'callWall',
      'putWall',
      'maxPain',
      'zeroGamma',
      'vannaWall',
      'charmWall',
      'largestCallOpenInterest',
      'largestPutOpenInterest',
      'weeklyOpexWall',
      'monthlyOpexWall',
      'zeroDaysToExpiryWall',
    ];
    for (const key of locations) expect(b[key], String(key)).toEqual(a[key]);
    expect(b.gammaFlips).toEqual(a.gammaFlips);
    expect(b.pinRisk).toEqual(a.pinRisk);
  });

  it('SIGN/REGIME fields are covariant — they flip with the convention', () => {
    expect(a.gammaRegime).not.toBeNull();
    expect(b.gammaRegime).toBe(a.gammaRegime === 'positive' ? 'negative' : 'positive');
    // The signed extremes swap ends (they are signed by definition, unlike the walls).
    expect(b.maxGammaStrike).toBe(a.minGammaStrike);
    expect(b.minGammaStrike).toBe(a.maxGammaStrike);
    // Aggregates negate.
    expect(flipped.aggregate.gex).toBeCloseTo(-positive.aggregate.gex, 9);
    expect(flipped.aggregate.dex).toBeCloseTo(-positive.aggregate.dex, 9);
    expect(flipped.aggregate.vanna).toBeCloseTo(-positive.aggregate.vanna, 9);
    expect(flipped.aggregate.speed).toBeCloseTo(-positive.aggregate.speed, 9);
    // As do the per-contract signs and the echoed convention.
    expect(flipped.assumptions.convention.calls).toBe(-positive.assumptions.convention.calls);
    expect(flipped.assumptions.convention.puts).toBe(-positive.assumptions.convention.puts);
  });
});

// ───────────────── 14. the per-tick path validates its spot ─────────────────

describe('atSpot guards the price it is handed', () => {
  const profile = profileWith('dealerShortGamma');

  it('rejects NaN / non-finite / non-positive spots (typed, not a NaN exposure)', () => {
    for (const bad of [Number.NaN, -50, 0, Number.POSITIVE_INFINITY]) {
      expect(() => profile.atSpot(bad), String(bad)).toThrow(InputError);
    }
    expect(() => profile.atSpot(Number.NaN)).toThrow(/finite positive/);
  });

  it('still reproduces the aggregate at the original spot', () => {
    const at = profile.atSpot(SPOT);
    expect(at.gex).toBeCloseTo(profile.aggregate.gex, 9);
    expect(at.dex).toBeCloseTo(profile.aggregate.dex, 9);
  });
});

// ───────────────── 15. option bags reject unknown keys ─────────────────

describe('levels() and scenarioMap() teach on a typo’d knob', () => {
  const profile = profileWith('dealerShortGamma');

  it('levels', () => {
    expect(() => profile.levels({ pinRiskBnd: 0.01 } as never)).toThrow(
      /pinRiskBnd.*did you mean "pinRiskBand"/s,
    );
    expect(() => profile.levels({ pinRiskBand: Number.NaN })).toThrow(InputError);
    expect(profile.levels({ pinRiskBand: 0.02 }).pinRisk).not.toBeNull();
  });

  it('scenarioMap', () => {
    // The killer typo: a plural axis name silently produced the DEFAULT one-spot grid.
    expect(() => profile.scenarioMap({ volatilityShocks: [-0.05, 0.05] } as never)).toThrow(
      /volatilityShocks.*did you mean "volatilityShock"/s,
    );
    expect(() => profile.scenarioMap({ spots: [90, 100] } as never)).toThrow(
      /spots.*did you mean "spot"/s,
    );
    expect(() => profile.scenarioMap({ metric: ['gex'] } as never)).toThrow(
      /metric.*did you mean "metrics"/s,
    );
    expect(() => profile.scenarioMap(null as never)).toThrow(InputError);
    // The documented knobs still work.
    const map = profile.scenarioMap({
      spot: [95, 100, 105],
      volatilityShock: [0],
      timeAdvance: [0],
      metrics: ['gex'],
    });
    expect(map.cells).toHaveLength(3);
  });
});

// ───────────────── 17. speed is the change in GEX for a +1% move ─────────────────

describe('speed exposure composes with gex', () => {
  it('aggregate.speed matches the finite difference of the profile’s own GEX (within 5%)', () => {
    for (const convention of ['callsPositivePutsNegative', 'dealerShortGamma'] as const) {
      const profile = profileWith(convention);
      const finiteDifference = profile.atSpot(SPOT * 1.01).gex - profile.atSpot(SPOT).gex;
      const relativeError =
        Math.abs(profile.aggregate.speed - finiteDifference) / Math.abs(finiteDifference);
      expect(relativeError, convention).toBeLessThan(0.05);
      // Sign agreement is not optional — the old third-order-only number could point either way.
      expect(Math.sign(profile.aggregate.speed), convention).toBe(Math.sign(finiteDifference));
    }
  });

  it('the per-strike rows sum to the aggregate', () => {
    const profile = profileWith('dealerShortGamma');
    const rows = profile.byStrike(['speed']);
    const summed = rows.reduce((s, r) => s + r.speed, 0);
    expect(summed).toBeCloseTo(profile.aggregate.speed, 6);
  });
});

// ───────────────── 18. the whole result is frozen, not just its rows ─────────────────

describe('an exposure profile is a snapshot', () => {
  const profile = profileWith('dealerShortGamma');

  it('aggregate, assumptions and the echoed convention are frozen', () => {
    expect(Object.isFrozen(profile.aggregate)).toBe(true);
    expect(Object.isFrozen(profile.assumptions)).toBe(true);
    expect(Object.isFrozen(profile.assumptions.convention)).toBe(true);
    expect(() => {
      (profile.aggregate as { gex: number }).gex = 0;
    }).toThrow(TypeError);
    expect(() => {
      (profile.assumptions as { gammaUnit: string }).gammaUnit = 'perPoint';
    }).toThrow(TypeError);
    expect(() => {
      (profile.assumptions.convention as { calls: number }).calls = 1;
    }).toThrow(TypeError);
    // The frozen echo is still a COPY: it never re-signs the internal computation.
    expect(profile.assumptions.convention.calls).toBe(-1);
  });
});

// ───────────────── 6. the trading DAY is America/New_York ─────────────────

describe('0DTE classification uses the market calendar, not the UTC date', () => {
  const friday = '2026-06-19';
  const wall = (asOf: number | string): Levels['zeroDaysToExpiryWall'] =>
    exposure({
      quotes: [quote('call', 100, 5_000, friday), quote('put', 100, 5_000, friday)],
      market: { spot: SPOT, riskFreeRate: RATE, asOf },
      config: { convention: 'dealerShortGamma' },
    }).levels().zeroDaysToExpiryWall;

  it('a Thursday 21:30 ET snapshot does NOT flag the Friday expiry as 0DTE', () => {
    // 21:30 ET Thursday = 01:30 UTC Friday: the UTC date already says Friday, the market does not.
    expect(wall(Date.UTC(2026, 5, 19, 1, 30))).toBeNull();
  });

  it('the same Friday expiry IS 0DTE from a Friday-morning snapshot', () => {
    expect(wall(Date.UTC(2026, 5, 19, 13, 30))).toBe(100); // 09:30 ET Friday
  });

  it('a date-only asOf is refused with the fix — the time of day decides whether it is 0DTE', () => {
    // A bare date would have to be guessed to an instant (UTC midnight is 20:00 ET on the 18th);
    // exposure prices through the valuation-instant door, which names the fix instead.
    expect(() => wall(friday)).toThrow(/is a date with no time of day/);
    expect(wall(`${friday}T09:30:00-04:00`)).toBe(100);
  });

  it('the weekly-OPEX bucket still finds the Friday from the Thursday-evening snapshot', () => {
    const levels = exposure({
      quotes: [quote('call', 100, 5_000, friday), quote('put', 100, 5_000, friday)],
      market: { spot: SPOT, riskFreeRate: RATE, asOf: Date.UTC(2026, 5, 19, 1, 30) },
      config: { convention: 'dealerShortGamma' },
    }).levels();
    expect(levels.zeroDaysToExpiryWall).toBeNull();
    expect(levels.weeklyOpexWall).toBe(100);
    expect(levels.monthlyOpexWall).toBe(100); // 2026-06-19 is the third Friday
  });
});

describe('flow 0DTE classification: the ET-day table', () => {
  function print(timestampMs: number, expiry: string): OptionTrade {
    return {
      contract: {
        underlying: 'SPY',
        type: 'call',
        style: 'european',
        strike: 100,
        expiry,
        multiplier: 100,
        ...resolvedExpiry(expiry),
      },
      timestampMs,
      price: 5,
      size: 1,
      bid: 4.9,
      ask: 5.1,
    };
  }

  const table: Array<[string, number, string, boolean]> = [
    ['14:00 ET on the expiry day (EDT)', Date.UTC(2026, 5, 19, 18), '2026-06-19', true],
    [
      '21:30 ET the day BEFORE (UTC already says expiry day)',
      Date.UTC(2026, 5, 19, 1, 30),
      '2026-06-19',
      false,
    ],
    [
      '20:30 ET ON the expiry day (UTC already says tomorrow)',
      Date.UTC(2026, 5, 20, 0, 30),
      '2026-06-19',
      true,
    ],
    ['14:00 ET the day before', Date.UTC(2026, 5, 18, 18), '2026-06-19', false],
    [
      '20:30 ET on the expiry day in WINTER (EST)',
      Date.UTC(2026, 0, 17, 1, 30),
      '2026-01-16',
      true,
    ],
    ['20:30 ET the day before in winter', Date.UTC(2026, 0, 16, 1, 30), '2026-01-16', false],
    ['09:30 ET on the expiry day in winter', Date.UTC(2026, 0, 16, 14, 30), '2026-01-16', true],
  ];

  it.each(table)('%s', (_label, timestampMs, expiry, expected) => {
    const analysis = flow([print(timestampMs, expiry)]);
    expect(analysis.trades[0]!.isZeroDaysToExpiry).toBe(expected);
    expect(analysis.zeroDaysToExpiry).toHaveLength(expected ? 1 : 0);
  });
});

// ───────────────── 19. the aggressor rule is named for what it does ─────────────────

describe('flow does not claim to be Lee–Ready', () => {
  function print(price: number, bid: number, ask: number): OptionTrade {
    const expiry = '2026-06-19';
    return {
      contract: {
        underlying: 'SPY',
        type: 'call',
        style: 'european',
        strike: 100,
        expiry,
        multiplier: 100,
        ...resolvedExpiry(expiry),
      },
      timestampMs: Date.UTC(2026, 5, 1, 14),
      price,
      size: 10,
      bid,
      ask,
    };
  }

  it('echoes the rule it actually applies, and the caveat matches the behaviour', () => {
    const analysis = flow([print(5.0, 4.9, 5.1)]);
    expect(analysis.assumptions.nbboRule).toBe('quote-rule-midpoint-unknown');
    const caveat = analysis.diagnostics.warnings.find((w) => /quote rule/i.test(w.message));
    expect(caveat).toBeDefined();
    expect(caveat!.message).toMatch(/no tick test/i);
    // The behaviour the label promises: a MIDPOINT print is unknown (a tick test would break the tie).
    expect(analysis.trades[0]!.side).toBe('unknown');
    expect(flow([print(5.1, 4.9, 5.1)]).trades[0]!.side).toBe('buy');
    expect(flow([print(4.9, 4.9, 5.1)]).trades[0]!.side).toBe('sell');
    expect(flow([print(5.05, 4.9, 5.1)]).trades[0]!.side).toBe('buy'); // inside, above the mid
  });
});
