import { describe, expect, it } from 'vitest';
import {
  type BarInput,
  type LiveStream,
  type TechnicalAnalysisSnapshot,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

// WS6.1 — forming-bar `update()`. These are framework-level guarantees exercised against a
// representative spread of indicators (number & object output, number & bar input, a candlestick,
// and a streaming price-action detector). `update()` is supplied by the VersionedStream wrapper, so
// proving it here proves it for all 300+ VersionedStream-wrapped indicators.

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.15);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.5,
  high: c + 1 + (i % 3),
  low: c - 1 - (i % 2),
  close: c,
  volume: 100 + i,
}));

const formingNum = (v: number): number => v * 1.006;
const formingBar = (b: BarInput): BarInput => ({
  ...b,
  high: b.high * 1.01,
  low: b.low * 0.99,
  close: b.close * 1.006,
});

/** Run the three WS6.1 guarantees for one indicator over one input series. */
function checkForming<In, Out>(
  makeStream: () => LiveStream<In, Out>,
  fromJSON: (s: TechnicalAnalysisSnapshot) => LiveStream<In, Out>,
  series: In[],
  formingOf: (v: In) => In,
  leakIterations = 10_000,
): void {
  // (a) update(a); update(b); next(c) commits the SAME series as plain next(c).
  const interleaved = makeStream();
  const plain = makeStream();
  for (const v of series) {
    interleaved.peek(formingOf(v));
    interleaved.peek(v);
    expect(interleaved.next(v)).toEqual(plain.next(v));
  }

  // (b) update(v) === the value a cloned stream produces via next(v); the source stream is untouched.
  const live = makeStream();
  const mid = Math.floor(series.length / 2);
  for (let i = 0; i < series.length; i++) {
    if (i === mid) {
      const forming = formingOf(series[i]!);
      const clone = fromJSON(live.toJSON());
      const wouldBe = live.peek(forming);
      expect(wouldBe).toEqual(clone.next(forming));
      // The source is not mutated: a second update reproduces the same value.
      expect(live.peek(forming)).toEqual(wouldBe);
    }
    live.next(series[i]!);
  }

  // (c) Alternating update/next leaks no state: the final committed snapshot matches a next-only run.
  const withUpdates = makeStream();
  const nextOnly = makeStream();
  for (let k = 0; k < leakIterations; k++) {
    const v = series[k % series.length]!;
    withUpdates.peek(formingOf(v));
    withUpdates.next(v);
    nextOnly.next(v);
  }
  expect(withUpdates.toJSON()).toEqual(nextOnly.toJSON());
}

describe('WS6.1 forming-bar update() — number-input indicators', () => {
  it('rsi (number → number)', () => {
    checkForming(() => ta.rsi.stream({ period: 14 }), ta.rsi.fromJSON, closes, formingNum);
  });

  it('macd (number → MacdPoint object)', () => {
    checkForming(
      () => ta.macd.stream({ fast: 12, slow: 26, signal: 9 }),
      ta.macd.fromJSON,
      closes,
      formingNum,
    );
  });
});

describe('WS6.1 forming-bar update() — bar-input indicators', () => {
  it('supertrend (bar → SupertrendPoint object)', () => {
    checkForming(
      () => ta.supertrend.stream({ period: 10, multiplier: 3 }),
      ta.supertrend.fromJSON,
      bars,
      formingBar,
    );
  });

  it('vwap (bar → number, cumulative)', () => {
    checkForming(() => ta.vwap.stream({}), ta.vwap.fromJSON, bars, formingBar);
  });

  it('candlesticks.doji (bar → number)', () => {
    const doji = ta.candlesticks['doji']!;
    checkForming(() => doji.stream({}), doji.fromJSON, bars, formingBar);
  });

  it('fairValueGaps (bar → ZonePoint, streaming price-action)', () => {
    checkForming(() => ta.fairValueGaps.stream({}), ta.fairValueGaps.fromJSON, bars, formingBar);
  });
});
