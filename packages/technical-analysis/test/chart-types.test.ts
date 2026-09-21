import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { RenkoStream, LineBreakStream } from '@totalfinance/technical-analysis/chart-types';

function barsFromCloses(closes: number[]): BarInput[] {
  return closes.map((c, i) => ({
    open: i === 0 ? c : closes[i - 1]!,
    high: Math.max(c, i === 0 ? c : closes[i - 1]!) + 0.01,
    low: Math.min(c, i === 0 ? c : closes[i - 1]!) - 0.01,
    close: c,
    volume: 100,
  }));
}

describe('Renko', () => {
  it('emits one up brick per brick-sized advance and reverses on a 2-brick pullback', () => {
    const bars = barsFromCloses([100, 101, 102, 103, 104, 102, 100]);
    const bricks = ta.charts.renko(bars, { brickSize: 1 });
    // 100→104 makes 4 up bricks, then 104→100 (4 down) reverses: skip 1 gap, then down bricks
    const ups = bricks.filter((b) => b.direction === 1).length;
    const downs = bricks.filter((b) => b.direction === -1).length;
    expect(ups).toBe(4);
    expect(downs).toBeGreaterThanOrEqual(2);
    // consecutive bricks step by exactly the brick size
    for (const b of bricks) expect(Math.abs(b.close - b.open)).toBeCloseTo(1, 9);
  });
  it('stream matches batch and round-trips a snapshot', () => {
    const bars = barsFromCloses([10, 11, 12, 11, 10, 9, 10, 11, 12, 13]);
    const batch = ta.charts.renko(bars, { brickSize: 1 });
    const stream = new RenkoStream(1);
    const streamed: unknown[] = [];
    bars.forEach((b) => streamed.push(...stream.next(b)));
    expect(streamed).toEqual(batch);
    // resume from a snapshot at the midpoint
    const s2 = new RenkoStream(1);
    const first: unknown[] = [];
    bars.slice(0, 5).forEach((b) => first.push(...s2.next(b)));
    const restored = RenkoStream.fromJSON(JSON.parse(JSON.stringify(s2.toJSON())));
    const rest: unknown[] = [];
    bars.slice(5).forEach((b) => rest.push(...restored.next(b)));
    expect([...first, ...rest]).toEqual(batch);
  });
});

describe('Three-Line Break', () => {
  it('forms a new line only on a break of the last N lines', () => {
    const bars = barsFromCloses([10, 11, 12, 13, 12.5, 11, 14]);
    const lines = ta.charts.lineBreak(bars, { lines: 3 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.direction).toBe(1);
    // a small pullback (12.5) inside the last 3 lines makes no new line
    const streamed = new LineBreakStream(3);
    const out: unknown[] = [];
    bars.forEach((b) => out.push(...streamed.next(b)));
    expect(out).toEqual(lines);
  });
});

describe('Kagi & Point and Figure', () => {
  it('Kagi reverses on a move of at least the reversal amount', () => {
    const bars = barsFromCloses([100, 102, 104, 101, 103, 99, 105]);
    const segs = ta.charts.kagi(bars, { reversal: 2 });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    // directions alternate
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.direction).not.toBe(segs[i - 1]!.direction);
    }
  });
  it('Point & Figure builds X and O columns with the box size', () => {
    const bars = barsFromCloses([10, 11, 12, 13, 14, 11, 8, 9, 12, 15]);
    const cols = ta.charts.pointAndFigure(bars, { boxSize: 1, reversal: 3 });
    expect(cols.length).toBeGreaterThanOrEqual(1);
    expect(['X', 'O']).toContain(cols[0]!.kind);
    for (const c of cols) {
      expect(c.high).toBeGreaterThan(c.low);
      expect(c.boxes).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('information-driven bars', () => {
  const bars: BarInput[] = Array.from({ length: 20 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i + 0.5,
    volume: 100,
  }));
  it('tick bars aggregate a fixed number of input bars', () => {
    const tb = ta.charts.tickBars(bars, { count: 5, flush: false });
    expect(tb).toHaveLength(4);
    expect(tb[0]!.open).toBe(bars[0]!.open);
    expect(tb[0]!.close).toBe(bars[4]!.close);
    expect(tb[0]!.high).toBe(Math.max(...bars.slice(0, 5).map((b) => b.high)));
  });
  it('volume bars close once cumulative volume crosses the threshold', () => {
    const vb = ta.charts.volumeBars(bars, { volume: 500, flush: false });
    expect(vb).toHaveLength(4); // 20 bars × 100 vol / 500 = 4 bars
    expect(vb.every((b) => b.volume! >= 500)).toBe(true);
  });
  it('dollar bars accumulate close×volume', () => {
    const db = ta.charts.dollarBars(bars, { dollar: 50000, flush: true });
    expect(db.length).toBeGreaterThan(0);
  });
  it('range bars close when the accumulated range reaches the size', () => {
    const rb = ta.charts.rangeBars(bars, { size: 3, flush: false });
    expect(rb.length).toBeGreaterThan(0);
    for (const b of rb) expect(b.high - b.low).toBeGreaterThanOrEqual(3);
  });
});
