import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { blackScholesGreeks } from '@totalfinance/options/black-scholes';
import { exposure } from '@totalfinance/structure';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-02-20'; // ~0.14y
const spot = 100;
const rate = 0.03;

function q(type: OptionType, strike: number, oi: number, impliedVolatility = 0.2): OptionQuote {
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

// Typical chain: heavier put OI below spot (support), heavier call OI above (resistance).
function chain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (let k = 85; k <= 115; k += 5) {
    rows.push(q('call', k, 200 + Math.max(0, k - 100) * 10));
    rows.push(q('put', k, 200 + Math.max(0, 100 - k) * 10));
  }
  return rows;
}

describe('exposure', () => {
  it('GEX matches the specification formula Γ·OI·mult·S²·0.01 with the convention sign', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000)],
      market: {
        riskFreeRate: rate,
        asOf,
        spot,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    const g = blackScholesGreeks({
      type: 'call',
      spot,
      strike: 100,
      timeToExpiryYears: prof.contracts[0]!.timeToExpiryYears,
      riskFreeRate: rate,
      dividendYield: 0,
      volatility: 0.2,
    });
    const expected = g.gamma * 1000 * 100 * spot * spot * 0.01; // call sign +1
    expect(prof.contracts[0]!.gex).toBeCloseTo(expected, 6);
    expect(prof.aggregate.gex).toBeCloseTo(expected, 6);
  });

  it('requires a convention and echoes it in assumptions with model.limitation warnings', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'dealerShortGamma' },
    });
    expect(prof.assumptions.convention.name).toBe('dealerShortGamma');
    expect(prof.assumptions.convention.calls).toBe(-1);
    expect(prof.assumptions.convention.puts).toBe(-1);
    const limitations = prof.diagnostics.warnings.filter((w) => w.code === 'model.limitation');
    expect(limitations.length).toBeGreaterThanOrEqual(2);
    // dealerShortGamma signs every contract negative, so puts contribute negative GEX too.
    expect(prof.contracts.every((c) => c.sign === -1)).toBe(true);
  });

  it('flips put GEX sign between conventions', () => {
    const a = exposure({
      quotes: [q('put', 95, 500)],
      market: {
        riskFreeRate: rate,
        asOf,
        spot,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    const b = exposure({
      quotes: [q('put', 95, 500)],
      market: {
        riskFreeRate: rate,
        asOf,
        spot,
      },
      config: {
        convention: { calls: 1, puts: 1 },
      },
    });
    expect(a.contracts[0]!.gex).toBeCloseTo(-b.contracts[0]!.gex, 9);
  });

  it('by-strike and by-expiry profiles sum the per-contract metrics', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const byK = prof.byStrike(['gex', 'dex']);
    expect(byK.map((r) => r.strike)).toEqual([85, 90, 95, 100, 105, 110, 115]);
    const totalGex = byK.reduce((s, r) => s + r.gex, 0);
    expect(totalGex).toBeCloseTo(prof.aggregate.gex, 6);
    const byE = prof.byExpiry(['gex']);
    expect(byE).toHaveLength(1);
    expect(byE[0]!.expiry).toBe(expiry);
  });

  it('requested-metrics selection narrows rows to ONLY the requested keys (WS2.4)', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });

    const gexOnly = prof.byStrike(['gex']);
    const row = gexOnly[0]!;
    expect('gex' in row).toBe(true);
    // unrequested metrics are ABSENT, not zero-filled
    expect('dex' in row).toBe(false);
    expect('vanna' in row).toBe(false);
    // compile-time: the narrowed row type does not expose an unrequested metric
    // @ts-expect-error dex is not a key of StrikeRow<'gex'>
    void row.dex;

    // the scenario map narrows the same way
    const cell = prof.scenarioMap({ spot: [spot], metrics: ['gex'] }).cells[0]!;
    expect('gex' in cell).toBe(true);
    expect('dex' in cell).toBe(false);
    expect('vanna' in cell).toBe(false);
    // @ts-expect-error vanna is not a key of ScenarioCell<'gex'>
    void cell.vanna;

    // and a full-metrics scenario map at (spot, 0, 0) still reproduces the base aggregate (golden)
    const full = prof.scenarioMap({ spot: [spot] });
    const base = full.cells[0]!;
    expect(base.gex).toBeCloseTo(prof.aggregate.gex, 6);
    expect(base.vanna).toBeCloseTo(prof.aggregate.vanna, 6);
    expect(base.charm).toBeCloseTo(prof.aggregate.charm, 6);
  });

  it('levels: max pain matches a brute-force recomputation; walls and pin risk are reported', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const lv = prof.levels();

    // Brute-force max pain from OI.
    const strikes = [...new Set(prof.contracts.map((c) => c.strike))];
    let bruteBest = strikes[0]!;
    let bestPain = Infinity;
    for (const S of strikes) {
      let pain = 0;
      for (const c of prof.contracts) {
        const intr = c.type === 'call' ? Math.max(S - c.strike, 0) : Math.max(c.strike - S, 0);
        pain += intr * c.openInterest * c.multiplier;
      }
      if (pain < bestPain) {
        bestPain = pain;
        bruteBest = S;
      }
    }
    expect(lv.maxPain).toBe(bruteBest);
    expect(lv.callWall).not.toBeNull();
    expect(lv.putWall).not.toBeNull();
    expect(lv.pinRisk).not.toBeNull();
    expect(lv.gammaRegime).not.toBeNull();
    // Largest call OI is at the highest strike (built that way); largest put OI at the lowest.
    expect(lv.largestCallOpenInterest).toBe(115);
    expect(lv.largestPutOpenInterest).toBe(85);
  });

  it('scenario map produces a spot×vol×time grid and reports its evaluation count', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const sm = prof.scenarioMap({
      spot: { from: 90, to: 110, steps: 11 },
      volatilityShock: [-0.05, 0, 0.05],
      timeAdvance: [0, 1 / 365],
      metrics: ['gex', 'dex'],
    });
    expect(sm.cells).toHaveLength(11 * 3 * 2);
    expect(sm.metrics).toEqual(['gex', 'dex']);
    expect(sm.evaluations).toBeGreaterThan(0);
  });

  it('does not leak NaN/Infinity into the aggregate under converged:true', () => {
    // Non-finite dividendYield is a hard input error.
    expect(() =>
      exposure({
        quotes: [q('call', 100, 1000)],
        market: {
          riskFreeRate: rate,
          asOf,
          spot,
          dividendYield: NaN,
        },
        config: {
          convention: 'callsPositivePutsNegative',
        },
      }),
    ).toThrow();

    // A row with Infinity OI or NaN multiplier is skipped (warned), never poisoning the aggregate.
    const bad: OptionQuote = {
      contract: {
        underlying: 'X',
        type: 'call',
        style: 'european',
        strike: 100,
        expiry,
        ...resolvedExpiry(expiry),
        multiplier: NaN,
      },
      timestampMs: asOf,
      impliedVolatility: 0.2,
      openInterest: Infinity,
      underlyingPrice: spot,
    };
    const prof = exposure({
      quotes: [q('call', 100, 1000), bad],
      market: {
        riskFreeRate: rate,
        asOf,
        spot,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    expect(prof.contracts).toHaveLength(1); // bad row skipped
    expect(Number.isFinite(prof.aggregate.gex)).toBe(true);
    expect(prof.diagnostics.warnings.some((w) => w.code === 'structure.contracts_skipped')).toBe(
      true,
    );
  });

  it('scenario map recomputes greeks: a single ATM call loses gamma as vol rises', () => {
    const prof = exposure({
      quotes: [q('call', 100, 1000)],
      market: {
        riskFreeRate: rate,
        asOf,
        spot,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    });
    const sm = prof.scenarioMap({ spot: [100], volatilityShock: [-0.05, 0.05], metrics: ['gex'] });
    const lowVolatility = sm.cells.find((c) => c.volatilityShock === -0.05)!.gex!;
    const highVolatility = sm.cells.find((c) => c.volatilityShock === 0.05)!.gex!;
    // ATM gamma ∝ 1/σ, so a lower vol gives a larger gamma exposure.
    expect(lowVolatility).toBeGreaterThan(highVolatility);
  });
});
