import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { pairs } from '@totalfinance/technical-analysis/statistics';

/**
 * Behavioral / closed-form contract tests for the utility-shaped and signal indicators that don't
 * have a clean external golden reference — `crossover`/`crossany`, `volumeProfile`, `smcSweep`,
 * `tosStdevAll`, `mavp`, and the bounded Ehlers sine waves (`msw`, `ebsw`). Batch≡stream and
 * serialization are already proven for these in registry-property.test.ts; here we pin down known
 * outputs, alignment, and edge cases.
 */

const pt = (price: number, volatility: number): BarInput => ({
  open: price,
  high: price + 0.2,
  low: price - 0.2,
  close: price,
  volume: volatility,
});

describe('crossover / crossany (closed form)', () => {
  // x crosses ABOVE y at i=1 and i=3; crosses BELOW at i=2
  const x = [0, 2, 1, 3];
  const y = [1, 1, 2, 2];
  it('crossover fires only when x crosses above y', () => {
    expect(ta.crossover(pairs(x, y), {})).toEqual([0, 1, 0, 1]);
  });
  it('crossany fires on a cross in either direction', () => {
    expect(ta.crossany(pairs(x, y), {})).toEqual([0, 1, 1, 1]);
  });
  it('a touch without a cross does not fire', () => {
    // x meets y (equal) then pulls back below — never strictly above
    expect(ta.crossover(pairs([0, 1, 0], [1, 1, 1]), {})).toEqual([0, 0, 0]);
  });
});

describe('smcSweep (closed form: +1 bull low-sweep, −1 bear high-sweep)', () => {
  const bars: BarInput[] = [
    { open: 9, high: 10, low: 8, close: 9 },
    { open: 9, high: 11, low: 9, close: 10 },
    { open: 10, high: 10.5, low: 8, close: 9 },
    // bar 3: high (12) sweeps the prior swing high (11) but closes back below it with a big upper wick
    { open: 10.5, high: 12, low: 10, close: 10 },
    // bar 4: ordinary inside-ish bar — no sweep
    { open: 10, high: 10.2, low: 9.8, close: 10 },
  ];
  it('flags the bearish high sweep and nothing else', () => {
    expect(ta.smcSweep(bars, { period: 3, wickMultiplier: 1.5 })).toEqual([0, 0, 0, -1, 0]);
  });
});

describe('volumeProfile (known distribution + edges)', () => {
  const bars: BarInput[] = [
    ...Array.from({ length: 10 }, () => pt(100, 100)),
    ...Array.from({ length: 2 }, () => pt(110, 5)),
  ];
  it('puts the POC at the high-volume price cluster, inside the value area', () => {
    const vp = ta.volumeProfile(bars, { bins: 24, valueAreaFraction: 0.7 });
    expect(vp.totalVolume).toBe(1010);
    expect(vp.bins).toHaveLength(24);
    expect(vp.poc!).toBeGreaterThan(99);
    expect(vp.poc!).toBeLessThan(101);
    expect(vp.valueArea.low!).toBeLessThanOrEqual(vp.poc!);
    expect(vp.valueArea.high!).toBeGreaterThanOrEqual(vp.poc!);
    // every bin's volume sums back to the total (no volume lost in the spread)
    const summed = vp.bins.reduce((s, b) => s + b.volume, 0);
    expect(summed).toBeCloseTo(1010, 6);
  });
  it('returns a well-formed empty profile for no bars (null POC, disclosed)', () => {
    const vp = ta.volumeProfile([], {});
    expect(vp.totalVolume).toBe(0);
    expect(vp.bins).toEqual([]);
    expect(vp.poc).toBeNull();
    expect(vp.valueArea).toEqual({ low: null, high: null });
    expect(vp.diagnostics.warnings[0]!.code).toBe('input.degenerate');
  });
});

describe('tosStdevAll (closed form: OLS line ± k·σ)', () => {
  it('matches the hand-computed line and symmetric source-stdev bands', () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = ta.tosStdevAll(series, { period: 5, stds: [1, 2], ddof: 0 });
    const last = out[9]!; // window [6,7,8,9,10]: OLS endpoint 10, σ=√2
    expect(last.line).toBeCloseTo(10, 9);
    expect(last.upper[0]!).toBeCloseTo(10 + Math.SQRT2, 9);
    expect(last.lower[0]!).toBeCloseTo(10 - Math.SQRT2, 9);
    expect(last.upper[1]!).toBeCloseTo(10 + 2 * Math.SQRT2, 9);
    // bands are symmetric around the line and ordered outward
    expect(last.upper[0]! - last.line).toBeCloseTo(last.line - last.lower[0]!, 9);
    expect(last.upper[1]!).toBeGreaterThan(last.upper[0]!);
  });

  it('warmup rows keep a stable band shape (NaN placeholders, not empty arrays)', () => {
    const out = ta.tosStdevAll([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { period: 5, stds: [1, 2] });
    // first `period − 1` rows are warmup: every row must still carry 2 lower + 2 upper bands
    for (let i = 0; i < 4; i++) {
      expect(out[i]!.lower).toHaveLength(2);
      expect(out[i]!.upper).toHaveLength(2);
      expect(out[i]!.line).toBeNaN();
      expect(out[i]!.lower.every(Number.isNaN)).toBe(true);
      expect(out[i]!.upper.every(Number.isNaN)).toBe(true);
    }
    // real rows have the same shape
    expect(out[9]!.lower).toHaveLength(2);
    expect(out[9]!.upper).toHaveLength(2);
  });
});

describe('mavp (variable-period MA: known outputs + alignment)', () => {
  const series = Array.from({ length: 20 }, (_, i) => 100 + i);
  it('reduces to a constant-period SMA when the period vector is constant', () => {
    const periods = series.map(() => 3);
    const out = ta.mavp({
      series,
      periods,
      parameters: { minPeriod: 2, maxPeriod: 3, movingAverageType: 'sma' },
    });
    const sma3 = ta.sma(series, { period: 3 });
    for (let i = 2; i < series.length; i++) expect(out[i]).toBeCloseTo(sma3[i]!, 9);
  });
  it('selects the per-bar period: the last bar uses its own requested window', () => {
    const periods = series.map((_, i) => (i === 19 ? 5 : 3));
    const out = ta.mavp({
      series,
      periods,
      parameters: { minPeriod: 2, maxPeriod: 5, movingAverageType: 'sma' },
    });
    expect(out[19]).toBeCloseTo(ta.sma(series, { period: 5 })[19]!, 9);
    expect(out[18]).toBeCloseTo(ta.sma(series, { period: 3 })[18]!, 9);
  });
});

describe('bounded Ehlers sine waves', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 6) * 10 + i * 0.05);
  it('msw sine/lead stay within [−1, 1]', () => {
    const out = ta.msw(closes, {});
    for (const p of out) {
      if (p == null || Number.isNaN(p.sine)) continue;
      expect(p.sine).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(p.sine).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.lead).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(p.lead).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('ebsw stays bounded near [−1, 1]', () => {
    const out = ta.ebsw(closes, { period: 40, bars: 10 });
    for (const v of out) {
      if (v == null || Number.isNaN(v)) continue;
      expect(Math.abs(v)).toBeLessThanOrEqual(1.2);
    }
  });
});
