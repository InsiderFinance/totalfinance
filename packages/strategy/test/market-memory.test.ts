import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { ironCondor, legs, strategy } from '../src/index.js';

/**
 * DX §4.2–4.3 (R4/R5) — a Position remembers the world it was built with:
 * - `expiry` materializes onto legs (leg > config.expiry > market.expiry),
 * - the construction `market` is the default for probability()/value()/scenarioTable()/chartData(),
 * - per-call overrides merge over it, and `assumptions.marketSource` echoes where the fields came
 *   from (R2: carried in assumptions, never hoisted top-level).
 */
const market = {
  spot: 570,
  volatility: 0.18,
  riskFreeRate: 0.045,
  asOf: '2026-07-06T00:00:00Z',
  expiry: '2026-08-21',
} as const;

const condorSpecification = { putLong: 540, putShort: 550, callShort: 590, callLong: 600 } as const;

function modelCondor() {
  return ironCondor(condorSpecification, { premiums: 'model', market });
}

describe('Position market memory (dx §4.3 / R5)', () => {
  it('probability() with ZERO arguments works on a model-premium position', () => {
    const p = modelCondor().probability();
    expect(p.probabilityOfProfit).toBeGreaterThan(0);
    expect(p.probabilityOfProfit).toBeLessThan(1);
    expect(p.assumptions.marketSource).toBe('construction');
    // R2: marketSource lives in assumptions only — never hoisted to the top level.
    expect('marketSource' in p).toBe(false);
    expect(p.assumptions.conventionsVersion).toBeTypeOf('string');
  });

  it('partial overrides merge over the construction market and echo marketSource merged', () => {
    const pos = modelCondor();
    const base = pos.probability();
    const bumped = pos.probability({ spot: 575 });
    expect(bumped.assumptions.marketSource).toBe('merged');
    expect(bumped.probabilityOfProfit).not.toBe(base.probabilityOfProfit);
    // Non-overridden fields still come from construction: same model vol.
    expect(bumped.assumptions.probabilityModel.volatility).toBe(
      base.assumptions.probabilityModel.volatility,
    );
  });

  it('a position built with no market at all echoes marketSource call', () => {
    const pos = strategy([
      legs.put({ strike: 540, premium: 3.4, quantity: 1 }),
      legs.put({ strike: 550, premium: 5.1, quantity: -1 }),
    ]);
    const p = pos.probability({
      spot: 570,
      volatility: 0.18,
      riskFreeRate: 0.045,
      asOf: '2026-07-06T00:00:00Z',
      expiry: market.expiry,
    });
    expect(p.assumptions.marketSource).toBe('call');
  });

  it('legs that carry a construction expiry make an otherwise call-supplied market merged', () => {
    const pos = strategy([
      legs.put({ strike: 540, premium: 3.4, expiry: market.expiry, quantity: 1 }),
    ]);
    const p = pos.probability({
      spot: 570,
      volatility: 0.18,
      riskFreeRate: 0.045,
      asOf: '2026-07-06T00:00:00Z',
    });
    // The expiry came from construction (the legs), the rest from the call — honestly merged.
    expect(p.assumptions.marketSource).toBe('merged');
  });

  it('missing fields throw ONE teaching error listing them all', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 2, quantity: 1 })]);
    try {
      pos.probability({ spot: 100 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      const msg = (e as Error).message;
      expect(msg).toContain('missing market field(s)');
      for (const field of ['vol', 'rate', 'asOf', 'expiry']) expect(msg).toContain(field);
    }
  });

  it('value() and scenarioTable() and chartData() default from the construction market too', () => {
    const pos = modelCondor();
    const markToMarket = pos.value();
    expect(markToMarket.assumptions.marketSource).toBe('construction');
    expect(Number.isFinite(markToMarket.pnl)).toBe(true);
    // scenarioTable is a Computed envelope (R2): rows in `value`, marketSource in assumptions.
    const table = pos.scenarioTable({ prices: [560, 570, 580] });
    expect(table.value).toHaveLength(3);
    expect(table.assumptions.marketSource).toBe('construction');
    expect(table.assumptions.conventionsVersion).toBeTypeOf('string');
    expect(table.diagnostics.warnings).toEqual([]);
    const chart = pos.chartData({
      prices: { from: 540, to: 600, steps: 3 },
      include: { expirationPnl: true, currentPnl: true },
    });
    expect(chart[0]!.currentPnl).toBeDefined();
  });

  it('monteCarloProbability merges the market but never defaults the seed', () => {
    const pos = modelCondor();
    const monteCarlo = pos.monteCarloProbability({ seed: 42, paths: 2000 });
    expect(monteCarlo.assumptions.marketSource).toBe('construction');
    expect(monteCarlo.seed).toBe(42);
  });

  it('mutating the caller market object after construction does not retarget the position', () => {
    const mine = { ...market };
    const pos = ironCondor(condorSpecification, { premiums: 'model', market: mine });
    const before = pos.probability().probabilityOfProfit;
    (mine as { spot: number }).spot = 700;
    expect(pos.probability().probabilityOfProfit).toBe(before);
  });
});

describe('expiry materialization (dx §4.2 / R4)', () => {
  it('legs carry the expiry the position was built with (from market.expiry)', () => {
    const pos = modelCondor();
    for (const leg of pos.legs) expect(leg.expiry).toBe('2026-08-21');
  });

  it('config.expiry wins over market.expiry; leg.expiry wins over both', () => {
    const pos = strategy(
      [
        legs.call({ strike: 100, premium: 2, quantity: 1 }),
        legs.call({ strike: 110, premium: 1, expiry: '2026-12-18', quantity: -1 }),
      ],
      { expiry: '2026-09-18', market },
    );
    expect(pos.legs[0]!.expiry).toBe('2026-09-18');
    expect(pos.legs[1]!.expiry).toBe('2026-12-18');
  });

  it('a garbage config.expiry fails at construction, not first use', () => {
    expect(() =>
      strategy([legs.call({ strike: 100, premium: 2, quantity: 1 })], { expiry: 'not-a-date' }),
    ).toThrow(InputError);
  });
});
