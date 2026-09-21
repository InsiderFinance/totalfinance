import { describe, expect, it } from 'vitest';
import { type TimeBar, alignToBars, rsi, resample } from '@totalfinance/technical-analysis';

const MIN = 60_000;
const HOUR = 3_600_000;

describe('WS6.2 resample — epoch-aligned OHLCV + VWAP', () => {
  // Seven 1m bars: minutes 0–4 fill the first 5m bucket (completed); minutes 5–6 open the second
  // (still forming).
  const oneMin: TimeBar[] = [
    { timestampMs: 0 * MIN, open: 100, high: 102, low: 99, close: 101, volume: 10 },
    { timestampMs: 1 * MIN, open: 101, high: 103, low: 100, close: 102, volume: 20 },
    { timestampMs: 2 * MIN, open: 102, high: 105, low: 101, close: 104, volume: 15 },
    { timestampMs: 3 * MIN, open: 104, high: 104, low: 98, close: 100, volume: 30 },
    { timestampMs: 4 * MIN, open: 100, high: 101, low: 97, close: 99, volume: 25 },
    { timestampMs: 5 * MIN, open: 99, high: 100, low: 95, close: 96, volume: 10 },
    { timestampMs: 6 * MIN, open: 96, high: 98, low: 94, close: 97, volume: 10 },
  ];

  it('aggregates a 5m bucket with hand-computed OHLCV and VWAP', () => {
    const out = resample(oneMin, '5m');
    // Only the completed bucket is emitted by default.
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.timestampMs).toBe(0);
    expect(b.open).toBe(100); // first
    expect(b.high).toBe(105); // max
    expect(b.low).toBe(97); // min
    expect(b.close).toBe(99); // last of the bucket
    expect(b.volume).toBe(100); // 10+20+15+30+25
    expect(b.partial).toBe(false);
    // VWAP = Σ(typical·vol)/Σvol, typical = (h+l+c)/3 = 10085/100.
    expect(b.vwap).toBeCloseTo(100.85, 10);
  });

  it('emits the forming bucket only with includePartial, flagged partial', () => {
    const out = resample(oneMin, '5m', { includePartial: true });
    expect(out).toHaveLength(2);
    expect(out[0]!.partial).toBe(false);
    expect(out[1]!.partial).toBe(true);
    expect(out[1]!.timestampMs).toBe(5 * MIN); // bucket start of the second 5m window
    expect(out[1]!.open).toBe(99);
    expect(out[1]!.close).toBe(97);
  });

  it('rejects an unknown interval string and a non-positive ms interval', () => {
    expect(() => resample(oneMin, '7m' as never)).toThrow(/unknown interval/);
    expect(() => resample(oneMin, 0)).toThrow(/positive/);
    expect(() => resample(oneMin, -5)).toThrow(/positive/);
  });

  it('rejects out-of-order bars and handles empty input', () => {
    expect(resample([], '5m')).toEqual([]);
    const backwards: TimeBar[] = [
      { timestampMs: 2 * MIN, open: 1, high: 1, low: 1, close: 1 },
      { timestampMs: 1 * MIN, open: 1, high: 1, low: 1, close: 1 },
    ];
    expect(() => resample(backwards, '5m')).toThrow(/ascending/);
  });

  it('falls back VWAP to the last typical price when a bucket has zero volume', () => {
    const noVolatility: TimeBar[] = [
      { timestampMs: 0, open: 10, high: 12, low: 8, close: 11 },
      { timestampMs: MIN, open: 11, high: 13, low: 9, close: 12 },
      { timestampMs: 5 * MIN, open: 1, high: 1, low: 1, close: 1 }, // opens a new bucket → first closes
    ];
    const out = resample(noVolatility, '5m');
    expect(out).toHaveLength(1);
    // No volume ⇒ vwap = the last bar's typical price (13+9+12)/3.
    expect(out[0]!.vwap).toBeCloseTo((13 + 9 + 12) / 3, 10);
  });

  // Regression for an external-review finding: only `ts` was validated, so a non-finite price silently
  // poisoned the bucket's max-high/min-low/close with NaN, and structurally impossible bars (high < low,
  // negative volume) passed through.
  it('rejects a non-finite OHLC price instead of emitting a NaN bucket', () => {
    const bad: TimeBar[] = [
      { timestampMs: 0, open: 10, high: Infinity, low: 8, close: 11, volume: 1 },
      { timestampMs: 5 * MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    expect(() => resample(bad, '5m')).toThrow(/high/);
  });

  it('rejects a bar with high < low', () => {
    const bad: TimeBar[] = [{ timestampMs: 0, open: 10, high: 8, low: 12, close: 11, volume: 1 }];
    expect(() => resample(bad, '5m')).toThrow(/high < low/);
  });

  it('rejects negative volume', () => {
    const bad: TimeBar[] = [{ timestampMs: 0, open: 10, high: 12, low: 8, close: 11, volume: -5 }];
    expect(() => resample(bad, '5m')).toThrow(/volume/);
  });
});

describe('WS6.2 alignToBars — ordering validation', () => {
  const htfBars: TimeBar[] = [
    { timestampMs: 0, open: 0, high: 0, low: 0, close: 0 },
    { timestampMs: HOUR, open: 0, high: 0, low: 0, close: 0 },
  ];
  const htfSeries = [10, 20];

  it('rejects an out-of-order lower (LTF) index', () => {
    const ltf: TimeBar[] = [
      { timestampMs: 0, open: 0, high: 0, low: 0, close: 0 },
      { timestampMs: 2 * HOUR, open: 0, high: 0, low: 0, close: 0 },
      { timestampMs: HOUR, open: 0, high: 0, low: 0, close: 0 }, // goes backwards
    ];
    expect(() =>
      alignToBars({ higherSeries: htfSeries, higherBars: htfBars, lowerBars: ltf }),
    ).toThrow(/lowerBars must be ascending/);
  });
});

describe('WS6.2 alignToBars — strictly causal step-hold', () => {
  const htfBars: TimeBar[] = [
    { timestampMs: 0, open: 0, high: 0, low: 0, close: 0 },
    { timestampMs: HOUR, open: 0, high: 0, low: 0, close: 0 },
    { timestampMs: 2 * HOUR, open: 0, high: 0, low: 0, close: 0 },
  ];
  const htfSeries = [10, 20, 30];
  const ltfBars: TimeBar[] = [0, 0.5, 1, 1.5, 2, 2.5].map((h) => ({
    timestampMs: h * HOUR,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
  }));

  it('is NaN before the first HTF bucket closes, then step-holds the last closed HTF value', () => {
    const aligned = alignToBars({
      higherSeries: htfSeries,
      higherBars: htfBars,
      lowerBars: ltfBars,
    });
    expect(aligned[0]).toBeNaN(); // ts 0: hour 0 not closed
    expect(aligned[1]).toBeNaN(); // ts 0.5h
    expect(aligned[2]).toBe(10); // ts 1h: hour 0 just closed
    expect(aligned[3]).toBe(10); // ts 1.5h: still hour 0
    expect(aligned[4]).toBe(20); // ts 2h: hour 1 closed
    expect(aligned[5]).toBe(20); // ts 2.5h
  });

  it('property: perturbing higherSeries[j] changes outputs ONLY at ts ≥ bucketEnd(j)', () => {
    const base = alignToBars({ higherSeries: htfSeries, higherBars: htfBars, lowerBars: ltfBars });
    for (let j = 0; j < htfSeries.length; j++) {
      const perturbed = htfSeries.slice();
      perturbed[j] = perturbed[j]! + 123;
      const after = alignToBars({
        higherSeries: perturbed,
        higherBars: htfBars,
        lowerBars: ltfBars,
      });
      const bucketEnd = htfBars[j]!.timestampMs + HOUR;
      for (let i = 0; i < ltfBars.length; i++) {
        const changed = !Object.is(base[i], after[i]);
        if (changed) expect(ltfBars[i]!.timestampMs).toBeGreaterThanOrEqual(bucketEnd);
      }
    }
  });
});

describe('WS6.2 end-to-end — RSI on 1h shown on the 1m index, no lookahead', () => {
  it('every 1m bar sees only the RSI of hours that have already closed', () => {
    // 20 full hours of 1m bars + 1 extra minute so all 20 hourly buckets close.
    const oneMin: TimeBar[] = [];
    for (let m = 0; m <= 20 * 60; m++) {
      const c = 100 + Math.sin(m / 37) * 6 + m * 0.01;
      oneMin.push({
        timestampMs: m * MIN,
        open: c,
        high: c + 0.5,
        low: c - 0.5,
        close: c,
        volume: 1,
      });
    }
    const hourly = resample(oneMin, '1h');
    expect(hourly).toHaveLength(20);
    const hourlyRsi = rsi(
      hourly.map((b) => b.close),
      { period: 14 },
    );
    const aligned = alignToBars({ higherSeries: hourlyRsi, higherBars: hourly, lowerBars: oneMin });
    expect(aligned).toHaveLength(oneMin.length);

    for (let i = 0; i < oneMin.length; i++) {
      const ts = oneMin[i]!.timestampMs;
      // The last hour that has CLOSED by ts: largest j with (j+1)·HOUR ≤ ts.
      const lastClosed = Math.floor(ts / HOUR) - 1;
      if (lastClosed < 0) {
        expect(aligned[i]).toBeNaN();
      } else {
        const expected = hourlyRsi[lastClosed]!;
        if (Number.isNaN(expected)) expect(aligned[i]).toBeNaN();
        else expect(aligned[i]).toBe(expected);
      }
    }
  });
});
