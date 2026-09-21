/**
 * Tests for the §11 exposure additions: higher-order exposures (theta/vomma/speed/color),
 * 0DTE/weekly/monthly OPEX walls, and the net-drift estimate.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { exposure } from '@totalfinance/structure';

const asOf = Date.UTC(2026, 0, 1, 14); // Thu 2026-01-01 14:00 UTC
const spot = 100;
const rate = 0.03;

function q(
  type: OptionType,
  strike: number,
  oi: number,
  expiry: string,
  impliedVolatility = 0.2,
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
    impliedVolatility,
    openInterest: oi,
    underlyingPrice: spot,
  };
}

const E = '2026-03-20'; // a future expiry, ~0.21y

describe('higher-order exposures (theta / vomma / speed / color)', () => {
  it('byStrike, byExpiry, and scenarioMap surface the new metrics and sum to the aggregate', () => {
    const chain = [q('call', 100, 500, E), q('put', 100, 500, E), q('call', 110, 300, E)];
    const prof = exposure({
      quotes: chain,
      market: { spot, riskFreeRate: rate, asOf },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const byK = prof.byStrike(['theta', 'vomma', 'speed', 'color']);
    const sum = (k: 'theta' | 'vomma' | 'speed' | 'color'): number =>
      byK.reduce((s, r) => s + r[k], 0);
    expect(sum('theta')).toBeCloseTo(prof.aggregate.theta, 8);
    expect(sum('vomma')).toBeCloseTo(prof.aggregate.vomma, 8);
    expect(sum('speed')).toBeCloseTo(prof.aggregate.speed, 8);
    expect(sum('color')).toBeCloseTo(prof.aggregate.color, 8);

    const map = prof.scenarioMap({ metrics: ['theta', 'vomma', 'speed', 'color'], spot: [spot] });
    const cell = map.cells[0]!;
    expect(cell.theta).toBeCloseTo(prof.aggregate.theta, 6);
    expect(cell.color).toBeCloseTo(prof.aggregate.color, 6);
  });

  it('theta exposure of a long call book is negative (time decay)', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000, E)],
      market: {
        spot,
        riskFreeRate: rate,
        asOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    expect(prof.aggregate.theta).toBeLessThan(0);
  });

  it('vomma exposure ≈ the change in vega exposure per +1% vol (central finite-difference)', () => {
    const market = { spot, riskFreeRate: rate, asOf };
    const config = { convention: 'callsPositivePutsNegative' as const };
    const vega = (impliedVolatility: number): number =>
      exposure({
        quotes: [q('call', 105, 1000, E, impliedVolatility)],
        market,
        config,
      }).aggregate.vega;
    const vomma = exposure({
      quotes: [q('call', 105, 1000, E, 0.2)],
      market,
      config,
    }).aggregate.vomma;
    const central = (vega(0.21) - vega(0.19)) / 2; // Δ vega exposure per +1% vol
    expect(Math.abs(vomma - central)).toBeLessThan(0.02 * Math.abs(central)); // within 2%
  });

  it('color exposure ≈ the change in GEX as ONE calendar day ELAPSES (central finite-difference)', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000, E)],
      market: {
        spot,
        riskFreeRate: rate,
        asOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    const map = prof.scenarioMap({
      spot: [spot],
      timeAdvance: [-1 / 365, 0, 1 / 365],
      metrics: ['gex', 'color'],
    });
    const elapsedPlus = map.cells.find((c) => c.timeAdvance === 1 / 365)!; // one calendar day later
    const elapsedMinus = map.cells.find((c) => c.timeAdvance === -1 / 365)!; // one calendar day earlier
    const now = map.cells.find((c) => c.timeAdvance === 0)!;
    // Elapsed-time convention: as a day passes T falls, so ∂GEX/∂(elapsed) = −∂GEX/∂T.
    const central = (elapsedPlus.gex! - elapsedMinus.gex!) / 2;
    expect(Math.abs(now.color! - central)).toBeLessThan(0.02 * Math.abs(central)); // within 2%
  });

  it('charm exposure ≈ the change in dollar-delta as ONE calendar day ELAPSES (OTM put chain)', () => {
    const prof = exposure({
      quotes: [q('put', 90, 1200, E), q('put', 85, 900, E)],
      market: {
        spot,
        riskFreeRate: rate,
        asOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    const map = prof.scenarioMap({
      spot: [spot],
      timeAdvance: [-1 / 365, 0, 1 / 365],
      metrics: ['dex', 'charm'],
    });
    const elapsedPlus = map.cells.find((c) => c.timeAdvance === 1 / 365)!; // one calendar day later
    const elapsedMinus = map.cells.find((c) => c.timeAdvance === -1 / 365)!; // one calendar day earlier
    const now = map.cells.find((c) => c.timeAdvance === 0)!;
    const central = (elapsedPlus.dex! - elapsedMinus.dex!) / 2; // ΔDEX per calendar day elapsed
    expect(Math.abs(now.charm! - central)).toBeLessThan(0.02 * Math.abs(central)); // within 2%
  });

  it('flipping the sign convention flips every exposure', () => {
    const chain = [q('call', 100, 800, E), q('put', 95, 600, E)];
    const a = exposure({
      quotes: chain,
      market: { spot, riskFreeRate: rate, asOf },
      config: { convention: { calls: 1, puts: 1 } },
    });
    const b = exposure({
      quotes: chain,
      market: { spot, riskFreeRate: rate, asOf },
      config: { convention: { calls: -1, puts: -1 } },
    });
    for (const m of ['theta', 'vomma', 'speed', 'color'] as const) {
      expect(b.aggregate[m]).toBeCloseTo(-a.aggregate[m], 8);
    }
  });
});

describe('OPEX walls (0DTE / weekly / monthly)', () => {
  // Disjoint strike ranges per expiry so each wall is traceable to its bucket.
  const chain: OptionQuote[] = [
    // 0DTE: same calendar day, datetime expiry so time-to-expiry stays > 0
    q('call', 98, 400, '2026-01-01T21:00:00Z'),
    q('call', 100, 900, '2026-01-01T21:00:00Z'),
    q('call', 102, 300, '2026-01-01T21:00:00Z'),
    // weekly: Fri 2026-01-09 (not a 3rd Friday)
    q('call', 104, 300, '2026-01-09'),
    q('call', 106, 800, '2026-01-09'),
    q('call', 108, 200, '2026-01-09'),
    // monthly: Fri 2026-01-16 (3rd Friday)
    q('call', 110, 300, '2026-01-16'),
    q('call', 112, 700, '2026-01-16'),
    q('call', 114, 200, '2026-01-16'),
  ];

  it('resolves each wall to the correct expiry bucket', () => {
    const levels = exposure({
      quotes: chain,
      market: {
        spot,
        riskFreeRate: rate,
        asOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect([98, 100, 102]).toContain(levels.zeroDaysToExpiryWall);
    expect([104, 106, 108]).toContain(levels.weeklyOpexWall);
    expect([110, 112, 114]).toContain(levels.monthlyOpexWall);
  });

  it('returns null walls when no contract matches a bucket', () => {
    const only0 = [q('call', 100, 500, '2026-01-01T21:00:00Z')];
    const levels = exposure({
      quotes: only0,
      market: {
        spot,
        riskFreeRate: rate,
        asOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect(levels.zeroDaysToExpiryWall).not.toBeNull();
    expect(levels.weeklyOpexWall).toBeNull();
    expect(levels.monthlyOpexWall).toBeNull();
  });
});

describe('date-only 0DTE expiries (resolved to market close, not midnight)', () => {
  // asOf is Thu 2026-01-01 14:00 UTC — before the 16:00 ET (21:00 UTC) close.
  it('keeps a same-day date-only contract alive and produces a 0DTE wall', () => {
    const chain = [q('call', 100, 900, '2026-01-01'), q('call', 105, 300, '2026-01-01')];
    const prof = exposure({
      quotes: chain,
      market: { spot, riskFreeRate: rate, asOf },
      config: { convention: 'callsPositivePutsNegative' },
    });
    expect(prof.contracts).toHaveLength(2); // not skipped as "expired" during the session
    expect(prof.aggregate.gex).not.toBe(0);
    expect([100, 105]).toContain(prof.levels().zeroDaysToExpiryWall);
  });

  it('still skips a date-only expiry once its market close has passed', () => {
    const afterClose = Date.UTC(2026, 0, 1, 22); // after 21:00 UTC close
    const prof = exposure({
      quotes: [q('call', 100, 900, '2026-01-01')],
      market: {
        spot,
        riskFreeRate: rate,
        asOf: afterClose,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    expect(prof.contracts).toHaveLength(0);
  });
});

describe('netDrift', () => {
  it('a call-heavy (positive-gamma) book pins; charm/vanna flows echo the aggregate', () => {
    const chain = [q('call', 100, 2000, E), q('call', 105, 1500, E), q('put', 95, 200, E)];
    const prof = exposure({
      quotes: chain,
      market: { spot, riskFreeRate: rate, asOf },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const drift = prof.netDrift();
    expect(drift.gammaRegime).toBe('positive');
    expect(drift.bias).toBe('pin');
    expect(drift.charmFlowPerDay).toBe(prof.aggregate.charm);
    expect(drift.vannaFlowPerVolatilityPoint).toBe(prof.aggregate.vanna);
  });
});
