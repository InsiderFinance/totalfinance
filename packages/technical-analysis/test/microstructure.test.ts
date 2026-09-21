import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  tradeSign,
  cumulativeVolumeDelta,
  CvdAggregator,
  tickVolumeProfile,
  bookImbalance,
  microprice,
  footprintBars,
  type Trade,
  type Quote,
  type OrderBook,
} from '@totalfinance/technical-analysis/microstructure';

describe('tradeSign — aggressor classification', () => {
  it('explicit side wins over everything (and the envelope echoes the method)', () => {
    const r = tradeSign.explain(
      { price: 10, size: 1, side: 'buy' },
      { quote: { bid: 11, ask: 12 } },
    );
    expect(r.value).toBe(1);
    expect(r.assumptions.method).toBe('side');
    expect(r.diagnostics.warnings).toEqual([]);
    expect(tradeSign({ price: 99, size: 1, side: 'sell' }, { previousPrice: 1 })).toBe(-1);
  });
  it('Lee-Ready quote rule: above mid = buy, below = sell', () => {
    const q: Quote = { bid: 10, ask: 10.04 }; // mid 10.02
    expect(tradeSign({ price: 10.03, size: 1 }, { quote: q })).toBe(1);
    expect(tradeSign({ price: 10.01, size: 1 }, { quote: q })).toBe(-1);
    expect(tradeSign.explain({ price: 10.03, size: 1 }, { quote: q }).assumptions.method).toBe(
      'quote',
    );
  });
  it('at the mid, falls back to the tick rule', () => {
    const q: Quote = { bid: 10, ask: 10.04 }; // mid 10.02
    const uptick = tradeSign.explain({ price: 10.02, size: 1 }, { quote: q, previousPrice: 10.0 });
    expect(uptick.value).toBe(1);
    expect(uptick.assumptions.method).toBe('tick'); // report the rule that actually resolved it
    expect(tradeSign({ price: 10.02, size: 1 }, { quote: q, previousPrice: 10.03 })).toBe(-1); // downtick
    expect(
      tradeSign({ price: 10.02, size: 1 }, { quote: q, previousPrice: 10.02, previousSign: -1 }),
    ).toBe(-1); // zero tick carries
  });
  it('tick rule when no quote: uptick/downtick/zero-tick-carry', () => {
    expect(tradeSign({ price: 5, size: 1 }, { previousPrice: 4 })).toBe(1);
    expect(tradeSign({ price: 5, size: 1 }, { previousPrice: 6 })).toBe(-1);
    expect(tradeSign({ price: 5, size: 1 }, { previousPrice: 5, previousSign: 1 })).toBe(1);
    const indeterminate = tradeSign.explain({ price: 5, size: 1 }, {}); // no context → indeterminate
    expect(indeterminate.value).toBe(0);
    expect(indeterminate.diagnostics.warnings[0]!.code).toBe('input.degenerate'); // disclosed, not silent
  });
  it('accepts decorated trade artifacts but rejects bad context/config and semantic values', () => {
    expect(tradeSign({ price: 5, size: 1, venue: 'XNYS' } as never)).toBe(0);
    expect(() => tradeSign({ price: 5, size: 1 }, { prevPirce: 4 } as never)).toThrow(InputError);
    expect(() => tradeSign({ price: 5, size: 1, side: 'hold' } as never)).toThrow(InputError);
    expect(() => tradeSign({ price: 5, size: 1 }, { previousSign: 2 } as never)).toThrow(
      InputError,
    );
    expect(() => tradeSign({ price: 5, size: -1 })).toThrow(InputError);
    expect(() => tradeSign({ price: 5, size: 1 }, { quote: { bid: 6, ask: 5 } })).toThrow(
      InputError,
    );
  });
});

describe('cumulativeVolumeDelta', () => {
  const tape: Trade[] = [
    { price: 100, size: 10, side: 'buy' },
    { price: 101, size: 5, side: 'sell' },
    { price: 101, size: 8, side: 'buy' },
    { price: 100, size: 3, side: 'sell' },
  ];
  it('signs, deltas, cumulative, and buy/sell volume are exact (report grammar inline)', () => {
    const r = cumulativeVolumeDelta(tape);
    expect(r.sign).toEqual([1, -1, 1, -1]);
    expect(r.delta).toEqual([10, -5, 8, -3]);
    expect(r.cumulative).toEqual([10, 5, 13, 10]);
    expect(r.buyVolume).toBe(18);
    expect(r.sellVolume).toBe(8);
    expect(r.assumptions.method).toBe('tick'); // no quotes supplied
    expect(r.diagnostics.warnings).toEqual([]);
  });
  it('throws on misaligned quotes and unknown parameters (Law 12)', () => {
    expect(() => cumulativeVolumeDelta(tape, { quotes: [{ bid: 1, ask: 2 }] })).toThrowError(
      /quotes length/,
    );
    expect(() => cumulativeVolumeDelta(tape, { quots: [] } as never)).toThrow(InputError);
  });
  it('tick method infers side from price changes when no explicit side', () => {
    const t: Trade[] = [
      { price: 10, size: 1 },
      { price: 11, size: 2 },
      { price: 10.5, size: 4 },
    ];
    const r = cumulativeVolumeDelta(t, { method: 'tick' });
    expect(r.sign).toEqual([0, 1, -1]); // first indeterminate, then up, then down
    expect(r.cumulative).toEqual([0, 2, -2]);
  });
  it('quote method uses Lee-Ready', () => {
    const t: Trade[] = [
      { price: 10.03, size: 5 },
      { price: 9.99, size: 4 },
    ];
    const quotes: Quote[] = [
      { bid: 10, ask: 10.04 },
      { bid: 9.98, ask: 10.0 },
    ];
    const r = cumulativeVolumeDelta(t, { method: 'quote', quotes });
    expect(r.sign).toEqual([1, -1]);
    expect(r.cumulative).toEqual([5, 1]);
  });
  it('validates every trade and every aligned quote, not only index zero', () => {
    expect(() =>
      cumulativeVolumeDelta([
        { price: 100, size: 1 },
        { price: 101, size: Number.NaN },
      ]),
    ).toThrow(/trades\[1\]\.size/);
    expect(() =>
      cumulativeVolumeDelta(
        [
          { price: 100, size: 1 },
          { price: 101, size: 1 },
        ],
        {
          quotes: [
            { bid: 99, ask: 101 },
            { bid: 102, ask: 101 },
          ],
        },
      ),
    ).toThrow(/quotes\[1\]/);
  });
});

describe('CvdAggregator — streaming + serializable', () => {
  const tape: Trade[] = Array.from({ length: 40 }, (_, i) => ({
    price: 100 + Math.sin(i / 3) * 2,
    size: 1 + (i % 5),
    side: (i % 3 === 0 ? 'buy' : 'sell') as 'buy' | 'sell',
  }));
  it('streaming reproduces the batch result and survives a JSON round-trip mid-tape', () => {
    const batch = cumulativeVolumeDelta(tape);
    let agg = new CvdAggregator('quote');
    const streamed: number[] = [];
    tape.forEach((t, i) => {
      streamed.push(agg.next(t).cumulative);
      if (i === 20) agg = CvdAggregator.fromJSON(JSON.parse(JSON.stringify(agg.toJSON())));
    });
    expect(streamed).toEqual(batch.cumulative);
    expect(agg.buyVolume).toBe(batch.buyVolume);
    expect(agg.sellVolume).toBe(batch.sellVolume);
  });
  it('does not poison reusable state when an accumulated value overflows', () => {
    const agg = new CvdAggregator('side');
    agg.next({ price: 100, size: Number.MAX_VALUE, side: 'buy' });
    expect(() => agg.next({ price: 101, size: Number.MAX_VALUE, side: 'buy' })).toThrow(
      /non-finite/,
    );
    expect(agg.cumulative).toBe(Number.MAX_VALUE);
    expect(agg.buyVolume).toBe(Number.MAX_VALUE);
  });
});

describe('tickVolumeProfile', () => {
  const trades: Trade[] = [
    { price: 100.0, size: 10, side: 'buy' },
    { price: 100.0, size: 5, side: 'sell' },
    { price: 100.5, size: 20, side: 'buy' }, // POC bucket
    { price: 101.0, size: 8, side: 'sell' },
  ];
  it('buckets by tickSize with exact volume, delta, POC, and totals', () => {
    const p = tickVolumeProfile(trades, { tickSize: 0.5, valueAreaFraction: 0.7 });
    // buckets: [100,100.5), [100.5,101), [101,101.5)
    expect(p.totalVolume).toBe(43);
    expect(p.totalDelta).toBe(10 - 5 + 20 - 8); // 17
    expect(p.bins[0]!.volume).toBe(15);
    expect(p.bins[0]!.delta).toBe(5); // 10 buy − 5 sell
    expect(p.bins[1]!.volume).toBe(20);
    expect(p.bins[1]!.buyVolume).toBe(20);
    expect(p.poc!).toBeCloseTo(100.75, 6); // midpoint of the [100.5,101) bucket
  });
  it('value area grows from the POC to hold the target volume fraction', () => {
    const p = tickVolumeProfile(trades, { tickSize: 0.5, valueAreaFraction: 0.6 });
    // POC bucket has 20/43 ≈ 47% < 60%; must expand to a neighbor
    expect(p.valueArea.low!).toBeLessThan(p.valueArea.high!);
    expect(p.bins.reduce((s, b) => s + b.volume, 0)).toBe(43);
  });
  it('empty tape returns an empty profile with null POC/value area, disclosed', () => {
    const p = tickVolumeProfile([]);
    expect(p.totalVolume).toBe(0);
    expect(p.bins).toEqual([]);
    expect(p.poc).toBeNull();
    expect(p.valueArea).toEqual({ low: null, high: null });
    expect(p.diagnostics.warnings[0]!.code).toBe('input.degenerate');
  });
  it('rejects a corrupt later print instead of returning a non-finite profile', () => {
    expect(() =>
      tickVolumeProfile([
        { price: 100, size: 1 },
        { price: 101, size: Number.NaN },
      ]),
    ).toThrow(/trades\[1\]\.size/);
  });
});

describe('bookImbalance + microprice', () => {
  const book: OrderBook = {
    bids: [
      { price: 10.0, size: 100 },
      { price: 9.99, size: 50 },
      { price: 9.98, size: 25 },
    ],
    asks: [
      { price: 10.01, size: 40 },
      { price: 10.02, size: 30 },
      { price: 10.03, size: 20 },
    ],
  };
  it('multi-level imbalance sums the top N levels', () => {
    // top 1: (100−40)/140
    expect(bookImbalance(book, { levels: 1 })).toBeCloseTo(60 / 140, 9);
    // top 3 equal weight: (175−90)/265
    expect(bookImbalance(book, { levels: 3 })).toBeCloseTo(85 / 265, 9);
  });
  it('weighted imbalance decays deeper levels by 1/(1+rank)', () => {
    const bid = 100 + 50 / 2 + 25 / 3;
    const ask = 40 + 30 / 2 + 20 / 3;
    const r = bookImbalance.explain(book, { levels: 3, weighted: true });
    expect(r.value).toBeCloseTo((bid - ask) / (bid + ask), 9);
    expect(r.assumptions).toMatchObject({ levels: 3, weighted: true }); // echoed conventions
  });
  it('microprice is the size-weighted mid (more ask size ⇒ nearer the bid)', () => {
    // (bestBid·askSize + bestAsk·bidSize)/(bidSize+askSize) = (10·40 + 10.01·100)/140
    expect(microprice(book)).toBeCloseTo((10.0 * 40 + 10.01 * 100) / 140, 9);
  });
  it('balanced book ⇒ 0; zero-depth ⇒ null with a warning (Law 7)', () => {
    expect(bookImbalance({ bids: [{ price: 1, size: 5 }], asks: [{ price: 2, size: 5 }] })).toBe(0);
    const empty = bookImbalance.explain({ bids: [], asks: [] });
    expect(empty.value).toBeNull();
    expect(empty.diagnostics.warnings[0]!.code).toBe('input.degenerate');
    const oneSided = microprice.explain({ bids: [], asks: [{ price: 2, size: 5 }] });
    expect(oneSided.value).toBeNull();
    expect(oneSided.diagnostics.warnings[0]!.code).toBe('input.degenerate');
  });
  it('rejects negative, unsorted, and crossed book levels while allowing metadata decoration', () => {
    const decorated = { ...book, venue: 'XNYS' };
    expect(bookImbalance(decorated)).toBeTypeOf('number');
    expect(() =>
      bookImbalance({ bids: [{ price: 10, size: -1 }], asks: [{ price: 11, size: 1 }] }),
    ).toThrow(InputError);
    expect(() =>
      bookImbalance({
        bids: [
          { price: 10, size: 1 },
          { price: 10.01, size: 1 },
        ],
        asks: [{ price: 11, size: 1 }],
      }),
    ).toThrow(/sorted best-first/);
    expect(() =>
      microprice({ bids: [{ price: 12, size: 1 }], asks: [{ price: 11, size: 1 }] }),
    ).toThrow(/crossed/);
  });
});

describe('footprintBars', () => {
  const trades: Trade[] = [
    { price: 100, size: 3, side: 'buy', time: 0 },
    { price: 101, size: 2, side: 'buy', time: 100 },
    { price: 100.5, size: 5, side: 'sell', time: 200 },
    { price: 102, size: 4, side: 'buy', time: 1500 },
    { price: 101.5, size: 1, side: 'sell', time: 1600 },
  ];
  it('volume buckets close a bar once cumulative size ≥ threshold', () => {
    const bars = footprintBars(trades, { by: 'volume', threshold: 5 });
    // bar1: trades 0,1 (3+2=5) → O100 H101 L100 C101, buy 5 sell 0 delta 5
    expect(bars[0]).toMatchObject({
      open: 100,
      high: 101,
      low: 100,
      close: 101,
      volume: 5,
      buyVolume: 5,
      sellVolume: 0,
      delta: 5,
      trades: 2,
    });
    // bar2: trade 2 (5) → sell 5
    expect(bars[1]).toMatchObject({
      open: 100.5,
      close: 100.5,
      volume: 5,
      sellVolume: 5,
      delta: -5,
    });
  });
  it('count buckets close every N trades', () => {
    const bars = footprintBars(trades, { by: 'count', threshold: 2 });
    expect(bars.length).toBe(3); // 2 + 2 + 1
    expect(bars[0]!.trades).toBe(2);
    expect(bars[2]!.trades).toBe(1);
  });
  it('time buckets split on elapsed milliseconds', () => {
    const bars = footprintBars(trades, { by: 'time', threshold: 1000 });
    // first three trades within [0,200], then a >1000ms gap opens a new bar
    expect(bars[0]!.trades).toBe(3);
    expect(bars[0]!.volume).toBe(10);
    expect(bars[1]!.trades).toBe(2);
  });
});

describe('validation', () => {
  it('throws InputError on bad parameters', () => {
    expect(() => tickVolumeProfile([{ price: 1, size: 1 }], { tickSize: -1 })).toThrow(InputError);
    expect(() => tickVolumeProfile([{ price: 1, size: 1 }], { valueAreaFraction: 2 })).toThrow(
      InputError,
    );
    expect(() => footprintBars([{ price: 1, size: 1 }], { threshold: 0 })).toThrow(InputError);
    expect(() =>
      footprintBars(
        [
          { price: 1, size: 1, time: 0 },
          { price: 2, size: 1 },
        ],
        { by: 'time', threshold: 1000 },
      ),
    ).toThrow(/trades\[1\]/);
    expect(() =>
      footprintBars(
        [
          { price: 1, size: 1, time: 1000 },
          { price: 2, size: 1, time: 999 },
        ],
        { by: 'time', threshold: 1000 },
      ),
    ).toThrow(/non-decreasing time/);
  });
});
