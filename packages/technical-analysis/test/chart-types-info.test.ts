import { describe, expect, it } from 'vitest';
import type { BarInput } from '@totalfinance/technical-analysis';
import {
  aggregators,
  dollarImbalanceBars,
  dollarRunBars,
  imbalanceBars,
  InformationBarAggregator,
  runBars,
  volumeImbalanceBars,
} from '@totalfinance/technical-analysis/chart-types';

const barsFrom = (closes: number[], volumes?: number[]): BarInput[] =>
  closes.map((c, i) => ({
    open: i === 0 ? c : closes[i - 1]!,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes ? volumes[i]! : 10,
  }));

describe('tick imbalance bars', () => {
  it('closes when the signed tick imbalance reaches the threshold (closed form)', () => {
    // signs (first = +1 carry): +1 +1 +1 −1 −1 −1 ; |Σ| hits 3 at index 2, then −3 at index 5
    const bars = barsFrom([10, 11, 12, 11, 10, 9]);
    const out = imbalanceBars(bars, { threshold: 3 });
    expect(out).toHaveLength(2);
    expect(out[0]!.close).toBe(12); // bars 0–2
    expect(out[0]!.high).toBe(13); // max high over 0–2
    expect(out[1]!.close).toBe(9); // bars 3–5
  });
});

describe('imbalance vs run bars distinguish on a mixed series', () => {
  // alternating closes → signs +1 +1 −1 +1 −1 +1 ; net imbalance oscillates 1,2,1,2,1,2 (never 3)
  const bars = barsFrom([10, 11, 10, 11, 10, 11]);
  it('imbalance bars never reach the threshold (one flushed bar)', () => {
    expect(imbalanceBars(bars, { threshold: 3 })).toHaveLength(1); // only the trailing flush
    expect(imbalanceBars(bars, { threshold: 3, flush: false })).toHaveLength(0);
  });
  it('run bars close on the dominant one-sided run (buy run hits 3)', () => {
    // buyRun accumulates ticks 0,1,3 → reaches 3 at index 3
    const out = runBars(bars, { threshold: 3 });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.close).toBe(11); // closes on bar index 3
  });
});

describe('volume / dollar weighting', () => {
  it('volume imbalance bars weight by signed volume', () => {
    // signs all +1; volumes 5,5,5 → cumulative signed volume 5,10,15 ≥ 12 at index 2
    const bars = barsFrom([10, 11, 12], [5, 5, 5]);
    const out = volumeImbalanceBars(bars, { threshold: 12 });
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(12);
    expect(out[0]!.volume).toBe(15);
  });
  it('dollar run bars weight by close·volume and produce valid OHLCV bars', () => {
    const bars = barsFrom([100, 101, 102, 101, 100], [10, 10, 10, 10, 10]);
    const out = dollarRunBars(bars, { threshold: 2000 });
    for (const b of out) {
      expect(b.high).toBeGreaterThanOrEqual(b.close);
      expect(b.low).toBeLessThanOrEqual(b.close);
    }
  });
});

describe('streaming aggregator equivalence & snapshots', () => {
  const bars = barsFrom(
    Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 4 === 0 ? 2 : -1)),
    Array.from({ length: 60 }, (_, i) => 100 + ((i * 13) % 50)),
  );
  it('the live aggregator (next + flush) equals the batch function', () => {
    const agg = aggregators.dollarImbalance(50000);
    const live: BarInput[] = [];
    for (const b of bars) live.push(...agg.next(b));
    live.push(...agg.flush());
    expect(live).toEqual(dollarImbalanceBars(bars, { threshold: 50000 }));
  });
  it('InformationBarAggregator round-trips mid-stream', () => {
    const ref = aggregators.volumeRun(400);
    const expected: BarInput[] = [];
    for (const b of bars) expected.push(...ref.next(b));

    const part = aggregators.volumeRun(400);
    const got: BarInput[] = [];
    for (let i = 0; i < 30; i++) got.push(...part.next(bars[i]!));
    const restored = InformationBarAggregator.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 30; i < bars.length; i++) got.push(...restored.next(bars[i]!));
    expect(got).toEqual(expected);
  });
});
