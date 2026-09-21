import { resolvedExpiry } from '@totalfinance/core';
/**
 * Verified review fixes (WS-2.6 / R2 conformance + honesty guards):
 *  1. netDrift/gammaProfileLevels return honest nulls on empty/degenerate books — never a
 *     fabricated zero-gamma at spot or a "flip" at every grid point.
 *  2. Envelope conformance: the sign convention and every resolved knob (gammaUnit, priceSource,
 *     minTimeToExpiry, defaultMultiplier) live in `assumptions`; limitations are
 *     `model.limitation` entries in `diagnostics.warnings`; nothing is hoisted top-level.
 *  3. Malformed prints/quotes throw teaching InputErrors (shape + index), never raw TypeErrors.
 *  4. Partially-tagged venue clusters fall back to timing-only sweeps instead of being suppressed.
 *  5. `DefaultScenarioMetric` is exported so TS consumers can name `scenarioMap()`'s return type.
 *  6. `market.asOf` accepts the ONE core `resolveAsOf` grammar: epoch ms | 'YYYY-MM-DD' | zoned ISO.
 */

import { describe, expect, it } from 'vitest';
import {
  InputError,
  WarningCode,
  type OptionQuote,
  type OptionTrade,
  type OptionType,
} from '@totalfinance/core';
import {
  exposure,
  flow,
  type DefaultScenarioMetric,
  type ScenarioMap,
} from '@totalfinance/structure';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-02-20';
const spot = 100;
const rate = 0.03;
const market = { riskFreeRate: rate, asOf, spot };
const config = { convention: 'callsPositivePutsNegative' as const };

function q(type: OptionType, strike: number, oi: number, uPx = spot): OptionQuote {
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
    impliedVolatility: 0.2,
    openInterest: oi,
    underlyingPrice: uPx,
  };
}

function t(
  strike: number,
  ts: number,
  price: number,
  size: number,
  bid: number,
  ask: number,
  exchange?: string,
): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type: 'call',
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
    ...(exchange !== undefined ? { exchange } : {}),
  };
}

describe('finding 1 — netDrift is honest on empty/degenerate books', () => {
  it('an empty book yields nulls, not a fabricated zero-gamma at spot', () => {
    const drift = exposure({ quotes: [], market, config }).netDrift();
    expect(drift.zeroGamma).toBeNull();
    expect(drift.distanceToZeroGamma).toBeNull();
    expect(drift.gammaRegime).toBeNull();
    expect(drift.bias).toBeNull();
    // The charm/vanna flows echo the (genuinely zero) aggregate — disclosed, not fabricated.
    expect(drift.charmFlowPerDay).toBe(0);
    expect(drift.vannaFlowPerVolatilityPoint).toBe(0);
  });

  it('an all-zero-OI book (every contract skipped) yields nulls too', () => {
    const prof = exposure({
      quotes: [q('call', 100, 0), q('put', 95, 0)],
      market,
      config,
    });
    expect(prof.contracts).toHaveLength(0);
    expect(prof.diagnostics.warnings.some((w) => w.code === 'structure.contracts_skipped')).toBe(
      true,
    );
    const drift = prof.netDrift();
    expect(drift.zeroGamma).toBeNull();
    expect(drift.gammaRegime).toBeNull();
    expect(drift.bias).toBeNull();
  });

  it('an empty book reports empty gammaFlips through levels() as well', () => {
    const lv = exposure({ quotes: [], market, config }).levels();
    expect(lv.zeroGamma).toBeNull();
    expect(lv.gammaFlips).toEqual([]);
    expect(lv.gammaRegime).toBeNull();
  });

  it('a real book still finds its gamma flip (no over-guarding)', () => {
    // Positive-gamma bump (calls @94) between two put walls (@82, @108) ⇒ genuine flips.
    const rows = [q('put', 82, 6000), q('call', 94, 7000), q('put', 108, 6000)];
    const drift = exposure({ quotes: rows, market, config }).netDrift();
    expect(drift.zeroGamma).not.toBeNull();
    expect(Number.isFinite(drift.distanceToZeroGamma!)).toBe(true);
    expect(drift.gammaRegime === 'positive' || drift.gammaRegime === 'negative').toBe(true);
    expect(drift.bias === 'pin' || drift.bias === 'trend').toBe(true);
    // And the flip list is a handful of real roots, not one per grid point (the old ≡0 bug).
    const lv = exposure({ quotes: rows, market, config }).levels();
    expect(lv.gammaFlips.length).toBeGreaterThanOrEqual(1);
    expect(lv.gammaFlips.length).toBeLessThan(10);
  });
});

describe('finding 2 — R2 envelope conformance (WS-2.6)', () => {
  it('exposure: convention + resolved knobs live in assumptions; nothing is hoisted', () => {
    const prof = exposure({ quotes: [q('call', 100, 1000)], market, config });
    expect(prof.assumptions.convention).toEqual({
      name: 'callsPositivePutsNegative',
      calls: 1,
      puts: -1,
    });
    // The previously-invisible defaults are echoed by name.
    expect(prof.assumptions.gammaUnit).toBe('per1PercentMove');
    expect(prof.assumptions.priceSource).toBe('mid');
    expect(prof.assumptions.minTimeToExpiry).toBe(0);
    expect(prof.assumptions.defaultMultiplier).toBe(100);
    expect(prof.assumptions.asOf).toBe(asOf);
    // No hoisted fields (R2): the old top-level `convention`/`limitations` are gone.
    expect('convention' in prof).toBe(false);
    expect('limitations' in prof).toBe(false);
  });

  it('exposure: non-default knobs are echoed as configured', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000)],
      market,
      config: {
        convention: { calls: -1, puts: -1 },
        gammaUnit: 'perPoint',
        priceSource: 'last',
        minTimeToExpiry: 0.01,
        defaultMultiplier: 50,
      },
    });
    expect(prof.assumptions.convention).toEqual({ name: 'custom', calls: -1, puts: -1 });
    expect(prof.assumptions.gammaUnit).toBe('perPoint');
    expect(prof.assumptions.priceSource).toBe('last');
    expect(prof.assumptions.minTimeToExpiry).toBe(0.01);
    expect(prof.assumptions.defaultMultiplier).toBe(50);
  });

  it('exposure: limitations ride diagnostics.warnings as model.limitation info entries', () => {
    const prof = exposure({ quotes: [q('call', 100, 1000)], market, config });
    const lims = prof.diagnostics.warnings.filter((w) => w.code === WarningCode.ModelLimitation);
    expect(lims.length).toBe(2);
    expect(lims.every((w) => w.severity === 'info')).toBe(true);
    expect(lims.some((w) => /not true dealer books/i.test(w.message))).toBe(true);
    // The sign-convention caveat keeps its message.
    expect(lims.some((w) => /calls \+, puts −|Naive net-gamma/i.test(w.message))).toBe(true);
  });

  it('flow: limitations ride diagnostics.warnings; assumptions is a core envelope', () => {
    const f = flow([t(100, 1000, 5.0, 1, 4.8, 5.0)]);
    expect('limitations' in f).toBe(false);
    expect(f.assumptions.conventionsVersion).toBeDefined();
    const lims = f.diagnostics.warnings.filter((w) => w.code === WarningCode.ModelLimitation);
    // Three standing caveats + the venue-verification caveat (no exchange data in this fixture).
    expect(lims.length).toBe(4);
    expect(lims.every((w) => w.severity === 'info')).toBe(true);
    // The aggressor caveat names the rule that actually runs (quote rule, midpoint ⇒ unknown, no
    // tick test) instead of claiming Lee–Ready.
    expect(lims.some((w) => /quote rule/i.test(w.message) && /no tick test/i.test(w.message))).toBe(
      true,
    );
    expect(lims.some((w) => /heuristic groupings/.test(w.message))).toBe(true);
    expect(lims.some((w) => /Opening estimate/.test(w.message))).toBe(true);
    expect(lims.some((w) => /venue-verified/.test(w.message))).toBe(true);
  });
});

describe('finding 3 — malformed elements teach, never raw TypeError', () => {
  it('flow([null]) throws a shape InputError naming trades[0]', () => {
    const bad = (): unknown => flow([null as unknown as OptionTrade]);
    expect(bad).toThrow(InputError);
    expect(bad).toThrow(/trades\[0\]/);
    expect(bad).not.toThrow(TypeError);
  });

  it('a print missing `contract` throws a shape InputError naming the contract shape', () => {
    const print = { price: 1.5, size: 10, ts: 1000 } as unknown as OptionTrade;
    const bad = (): unknown => flow([print]);
    expect(bad).toThrow(InputError);
    expect(bad).toThrow(/trades\[0\]\.contract/);
    // The received-keys echo turns the error into documentation of the expected shape.
    expect(bad).toThrow(/received keys: price, size, ts/);
  });

  it('a malformed print at a later index reports THAT index', () => {
    const bad = (): unknown =>
      flow([t(100, 1000, 5.0, 1, 4.8, 5.0), null as unknown as OptionTrade]);
    expect(bad).toThrow(/trades\[1\]/);
  });

  it('exposure([null]) throws a shape InputError naming quotes[0]', () => {
    const bad = (): unknown =>
      exposure({ quotes: [null as unknown as OptionQuote], market, config });
    expect(bad).toThrow(InputError);
    expect(bad).toThrow(/quotes\[0\]/);
    expect(bad).not.toThrow(TypeError);
  });

  it('exposure([{}]) throws a shape InputError naming quotes[0].contract', () => {
    const bad = (): unknown => exposure({ quotes: [{} as OptionQuote], market, config });
    expect(bad).toThrow(InputError);
    expect(bad).toThrow(/quotes\[0\]\.contract/);
  });
});

describe('finding 4 — partial venue tagging falls back to timing-only sweeps', () => {
  it('a mixed tagged/untagged cluster is still detected (timing-only, not venue-verified)', () => {
    const f = flow([
      t(105, 1000, 2.0, 10, 1.9, 2.0, 'CBOE'),
      t(105, 1100, 2.0, 15, 1.9, 2.0),
      t(105, 1200, 2.0, 20, 1.9, 2.0),
    ]);
    expect(f.sweeps).toHaveLength(1);
    expect(f.sweeps[0]!.venueVerified).toBe(false);
    expect(f.diagnostics.warnings.some((w) => w.code === 'flow.sweeps_not_venue_verified')).toBe(
      true,
    );
  });

  it('a fully multi-tagged cluster stays venue-verified', () => {
    const f = flow([
      t(105, 1000, 2.0, 10, 1.9, 2.0, 'CBOE'),
      t(105, 1100, 2.0, 15, 1.9, 2.0, 'ISE'),
      t(105, 1200, 2.0, 20, 1.9, 2.0, 'CBOE'),
    ]);
    expect(f.sweeps).toHaveLength(1);
    expect(f.sweeps[0]!.venueVerified).toBe(true);
  });

  it('a FULLY-tagged single-venue burst is still rejected as an iceberg (regression)', () => {
    const f = flow([
      t(105, 1000, 2.0, 10, 1.9, 2.0, 'CBOE'),
      t(105, 1100, 2.0, 15, 1.9, 2.0, 'CBOE'),
      t(105, 1200, 2.0, 20, 1.9, 2.0, 'CBOE'),
    ]);
    expect(f.sweeps).toHaveLength(0);
  });
});

describe('finding 5 — DefaultScenarioMetric is a public named type', () => {
  it("TS consumers can name scenarioMap()'s default return type", () => {
    const metric: DefaultScenarioMetric = 'gex';
    expect(['gex', 'dex', 'vanna', 'charm']).toContain(metric);
    // The default (metric-less) scenarioMap is assignable to ScenarioMap<DefaultScenarioMetric>.
    const sm: ScenarioMap<DefaultScenarioMetric> = exposure({
      quotes: [q('call', 100, 1000)],
      market,
      config,
    }).scenarioMap({ spot: [spot] });
    expect(sm.metrics).toEqual(['gex', 'dex', 'vanna', 'charm']);
  });
});

describe('finding 6 — market.asOf speaks the ONE core valuation-instant grammar', () => {
  it("refuses a bare 'YYYY-MM-DD' with the fix, and resolves the equivalent zoned instant exactly like epoch ms", () => {
    expect(() =>
      exposure({
        quotes: [q('call', 100, 1000)],
        market: { riskFreeRate: rate, spot, asOf: '2026-01-01' },
        config,
      }),
    ).toThrow(/asOf "2026-01-01" is a date with no time of day/);
    const fromString = exposure({
      quotes: [q('call', 100, 1000)],
      market: { riskFreeRate: rate, spot, asOf: '2026-01-01T00:00:00Z' },
      config,
    });
    const fromEpoch = exposure({ quotes: [q('call', 100, 1000)], market, config });
    expect(fromString.assumptions.asOf).toBe(asOf); // the same instant, deterministic
    expect(fromString.aggregate.gex).toBeCloseTo(fromEpoch.aggregate.gex, 9);
  });

  it('accepts a ZONED ISO datetime', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000)],
      market: { riskFreeRate: rate, spot, asOf: '2026-01-01T14:00Z' },
      config,
    });
    expect(prof.assumptions.asOf).toBe(Date.UTC(2026, 0, 1, 14));
  });

  it('rejects a bare zone-less datetime with the core teaching error', () => {
    const bad = (): unknown =>
      exposure({
        quotes: [q('call', 100, 1000)],
        market: { riskFreeRate: rate, spot, asOf: '2026-01-01T14:00' },
        config,
      });
    expect(bad).toThrow(InputError);
    expect(bad).toThrow(/no timezone/);
  });

  it('still rejects a non-finite numeric asOf', () => {
    expect(() =>
      exposure({
        quotes: [q('call', 100, 1000)],
        market: { riskFreeRate: rate, spot, asOf: NaN },
        config,
      }),
    ).toThrow(InputError);
  });
});
