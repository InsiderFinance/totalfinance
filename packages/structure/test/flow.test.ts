import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionTrade, OptionType } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';

const expiry = '2026-03-20';

function trade(
  type: OptionType,
  strike: number,
  ts: number,
  price: number,
  size: number,
  bid: number,
  ask: number,
  openInterest?: number,
): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type,
      style: 'european',
      strike,
      expiry,
      multiplier: 100,
      ...resolvedExpiry(expiry),
    },
    timestampMs: ts,
    price,
    size,
    bid,
    ask,
    ...(openInterest !== undefined ? { openInterest } : {}),
  };
}

describe('flow', () => {
  it('classifies aggressor side from NBBO', () => {
    const f = flow([
      trade('call', 100, 1000, 5.0, 1, 4.8, 5.0), // at ask → buy
      trade('call', 100, 1001, 4.8, 1, 4.8, 5.0), // at bid → sell
      trade('call', 100, 1002, 4.9, 1, 4.8, 5.0), // mid → unknown
    ]);
    expect(f.trades.map((t) => t.side)).toEqual(['buy', 'sell', 'unknown']);
    expect(
      f.diagnostics.warnings.filter((w) => w.code === 'model.limitation').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('detects a sweep (≥3 same-side prints on one contract within the window)', () => {
    const f = flow(
      [
        trade('call', 105, 1000, 2.0, 10, 1.9, 2.0),
        trade('call', 105, 1100, 2.0, 15, 1.9, 2.0),
        trade('call', 105, 1300, 2.0, 20, 1.9, 2.0),
        trade('call', 105, 1450, 2.0, 12, 1.9, 2.0),
      ],
      { sweepWindowMs: 500, sweepMinPrints: 3 },
    );
    expect(f.sweeps).toHaveLength(1);
    expect(f.sweeps[0]!.prints).toBe(4);
    expect(f.sweeps[0]!.side).toBe('buy');
    expect(f.sweeps[0]!.size).toBe(57);
    expect(f.trades.every((t) => t.sweepId === 1)).toBe(true);
  });

  it('flags blocks by size or premium', () => {
    const f = flow(
      [
        trade('put', 95, 1000, 3.0, 250, 2.9, 3.1), // big size → block
        trade('put', 95, 2000, 3.0, 5, 2.9, 3.1), // small → not a block
      ],
      { blockMinSize: 100 },
    );
    expect(f.blocks).toHaveLength(1);
    expect(f.blocks[0]!.size).toBe(250);
  });

  it('detects a multi-leg spread (≥2 contracts at the same instant)', () => {
    const f = flow(
      [
        trade('call', 100, 5000, 3.0, 10, 2.9, 3.1), // bought
        trade('call', 110, 5000, 1.0, 10, 0.9, 1.1, undefined), // sold (at bid)
      ],
      { spreadWindowMs: 100 },
    );
    // second leg priced at bid (0.9) → sell
    expect(f.spreads).toHaveLength(1);
    expect(f.spreads[0]!.legs).toBe(2);
    expect(f.trades.every((t) => t.spreadId === 1)).toBe(true);
  });

  it('groups and ranks by premium with thresholds and volume/OI ratio', () => {
    const f = flow([
      trade('call', 100, 1000, 5.0, 100, 4.8, 5.0, 50), // premium 50_000, vol/oi = 2
      trade('call', 100, 1001, 5.0, 50, 4.8, 5.0, 50), // same contract
      trade('put', 90, 1002, 1.0, 10, 0.9, 1.1, 1000), // premium 1_000
    ]);
    const groups = f.groupBy(['underlying', 'expiry', 'strike', 'type']);
    const ranked = f.rank(groups, { by: 'premium', minPremium: 10_000 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.strike).toBe(100);
    expect(ranked[0]!.premium).toBeCloseTo(5 * 150 * 100, 6);
    expect(ranked[0]!.volumeOpenInterestRatio).toBeCloseTo(150 / 50, 9);
  });
});

describe('flow rejects malformed trade prints (fail loudly on bad vendor data)', () => {
  const good = (): OptionTrade => trade('call', 100, 1_000, 5, 10, 4.9, 5.1);

  it('a valid print is accepted', () => {
    expect(() => flow([good()])).not.toThrow();
  });

  it('rejects a NaN price, non-positive size, non-finite ts, and bad strike/multiplier', () => {
    expect(() => flow([{ ...good(), price: NaN }])).toThrow(/price/);
    expect(() => flow([{ ...good(), size: -10 }])).toThrow(/size/);
    expect(() => flow([{ ...good(), size: 0 }])).toThrow(/size/);
    expect(() => flow([{ ...good(), timestampMs: NaN }])).toThrow(/timestampMs/);
    expect(() => flow([{ ...good(), contract: { ...good().contract, strike: -1 } }])).toThrow(
      /strike/,
    );
    expect(() => flow([{ ...good(), contract: { ...good().contract, multiplier: 0 } }])).toThrow(
      /multiplier/,
    );
  });

  it('rejects a negative supplied premium', () => {
    expect(() => flow([{ ...good(), premium: -100 }])).toThrow(/premium/);
  });
});
