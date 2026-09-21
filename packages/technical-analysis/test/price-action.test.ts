import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const pa = ta.priceAction;

describe('pivot points', () => {
  const day: BarInput = { open: 100, high: 110, low: 90, close: 105 };
  it('classic pivots use (H+L+C)/3 with symmetric R1/S1', () => {
    const p = pa.pivots(day, 'classic');
    expect(p.pivot).toBeCloseTo((110 + 90 + 105) / 3, 12);
    expect(p.resistance[0]).toBeCloseTo(2 * p.pivot - 90, 12);
    expect(p.support[0]).toBeCloseTo(2 * p.pivot - 110, 12);
  });
  it('camarilla exposes four levels each side', () => {
    const p = pa.pivots(day, 'camarilla');
    expect(p.resistance).toHaveLength(4);
    expect(p.support).toHaveLength(4);
    // levels are ordered outward from price
    expect(p.resistance[3]).toBeGreaterThan(p.resistance[0]!);
  });
  it('every method returns a finite pivot', () => {
    for (const m of ['classic', 'fibonacci', 'woodie', 'camarilla', 'demark'] as const) {
      expect(Number.isFinite(pa.pivots(day, m).pivot)).toBe(true);
    }
  });
});

describe('swings & fractals', () => {
  // a clear zigzag: up to 5, down to 1, up to 6
  const closes = [1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6];
  const bars: BarInput[] = closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c, open: c }));
  it('finds the swing high at the peak and swing low at the trough', () => {
    const s = pa.swings(bars, { strength: 2 });
    expect(s.highs.some((p) => p.index === 4)).toBe(true); // the 5 peak
    expect(s.lows.some((p) => p.index === 8)).toBe(true); // the 1 trough
  });
  it('fractals are 5-bar swings', () => {
    const f = pa.fractals(bars);
    expect(f.up.length).toBeGreaterThan(0);
    expect(f.down.length).toBeGreaterThan(0);
  });
});

describe('support / resistance & trendlines', () => {
  const closes = [10, 12, 10, 13, 10, 14, 10, 12.05, 10.02];
  const bars: BarInput[] = closes.map((c) => ({ high: c + 0.2, low: c - 0.2, close: c, open: c }));
  it('clusters nearby swing lows into a support level with touch counts', () => {
    const sr = pa.supportResistance(bars, { strength: 1, tolerance: 0.05 });
    expect(sr.support.length).toBeGreaterThan(0);
    expect(sr.support[0]!.touches).toBeGreaterThanOrEqual(2); // the ~10 lows cluster
  });
  it('trendlines connect the last two swings', () => {
    const t = pa.trendlines(bars, { strength: 1 });
    if (t.support) {
      const at = pa.lineAt(t.support, t.support.to);
      expect(Number.isFinite(at)).toBe(true);
    }
    expect(t).toHaveProperty('resistance');
  });
});

describe('breakouts & gaps', () => {
  it('flags a breakout when close clears the prior range high', () => {
    const bars: BarInput[] = Array.from({ length: 25 }, () => ({
      high: 100 + 0.1,
      low: 100 - 0.1,
      close: 100,
      open: 100,
    }));
    bars.push({ high: 105, low: 104, close: 105, open: 104 }); // breakout bar
    const b = pa.breakouts(bars, { lookback: 20 });
    expect(b.signal.at(-1)).toBe(1);
    expect(b.signal.slice(0, 20).every((x) => x === null)).toBe(true); // warmup is null, not NaN
    expect(b.assumptions.lookback).toBe(20);
  });
  it('detects gap up and gap down with a minimum percentage', () => {
    const bars: BarInput[] = [
      { open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { open: 105, high: 106, low: 104, close: 105, volume: 1 }, // gaps up over prior high
      { open: 95, high: 96, low: 94, close: 95, volume: 1 }, // gaps down under prior low
    ];
    const g = pa.gaps(bars, { minSizeFraction: 0.01 });
    expect(g.gaps.find((x) => x.index === 1)!.direction).toBe(1);
    expect(g.gaps.find((x) => x.index === 2)!.direction).toBe(-1);
    expect(g.assumptions.minSizeFraction).toBe(0.01);
  });
});

describe('market structure', () => {
  it('labels HH/HL/LH/LL and emits BOS/CHoCH', () => {
    // up: HH/HL, then a lower low to flip
    const closes = [1, 3, 2, 5, 3, 7, 4, 2, 1, 0.5];
    const bars: BarInput[] = closes.map((c) => ({
      high: c + 0.3,
      low: c - 0.3,
      close: c,
      open: c,
    }));
    const ms = pa.marketStructure(bars, { strength: 1 });
    expect(ms.swings.length).toBeGreaterThan(0);
    const labels = new Set(ms.swings.map((s) => s.label));
    expect([...labels].some((l) => l === 'HH' || l === 'HL')).toBe(true);
    // a directional change should be recorded once the lows roll over
    expect(ms.events.some((e) => e.type === 'CHoCH' || e.type === 'BOS')).toBe(true);
  });
});

describe('session range & opening-range breakout', () => {
  const bars: BarInput[] = Array.from({ length: 12 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 10,
  }));
  it('aggregates bars into per-session OHLCV + range', () => {
    const ids = bars.map((_, i) => Math.floor(i / 4)); // 3 sessions of 4 bars
    const sr = pa.sessionRanges(bars, ids);
    expect(sr).toHaveLength(3);
    expect(sr[0]!.open).toBe(bars[0]!.open);
    expect(sr[0]!.high).toBe(Math.max(...bars.slice(0, 4).map((b) => b.high)));
    expect(sr[0]!.range).toBe(sr[0]!.high - sr[0]!.low);
    expect(sr[0]!.volume).toBe(40);
  });
  it('opening-range breakout fires above the first-N-bar range', () => {
    const or = pa.openingRange(bars, { periods: 3 });
    expect(or.high).toBe(Math.max(...bars.slice(0, 3).map((b) => b.high)));
    const orb = pa.openingRangeBreakout(bars, { periods: 3 });
    expect(orb.slice(0, 3).every((x) => Number.isNaN(x))).toBe(true);
    expect(orb.at(-1)).toBe(1); // rising series breaks out above the opening range
  });
});
