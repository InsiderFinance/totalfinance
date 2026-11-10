import { describe, expect, it } from 'vitest';
import { ohlcvFromBars, vwap } from '../src/index.js';

describe('explicit source Bar → indicator OHLCV projection', () => {
  it('preserves the original observations and optional volume without filling it', () => {
    const bars = [
      {
        symbol: 'TEST',
        timestampMs: 1_000,
        open: 10,
        high: 12,
        low: 8,
        close: 10,
        volume: 2,
        adjusted: false,
        provenance: { source: 'synthetic' },
      },
      {
        symbol: 'TEST',
        timestampMs: 2_000,
        open: 12,
        high: 14,
        low: 10,
        close: 12,
        volume: 4,
        adjusted: false,
      },
    ];
    const before = structuredClone(bars);
    const rows = ohlcvFromBars(bars);
    expect(rows).toEqual([
      { open: 10, high: 12, low: 8, close: 10, volume: 2 },
      { open: 12, high: 14, low: 10, close: 12, volume: 4 },
    ]);
    expect(vwap(rows)[1]).toBeCloseTo(68 / 6, 12);
    rows[0]!.close = 11;
    expect(bars).toEqual(before);
    const { volume: _volume, ...without } = bars[0]!;
    expect(ohlcvFromBars([without])[0]).not.toHaveProperty('volume');
  });
  it('validates the last row, source identity and time, and OHLC semantics', () => {
    const valid = { symbol: 'TEST', timestampMs: 1, open: 10, high: 12, low: 8, close: 10 };
    for (const change of [
      { symbol: '' },
      { timestampMs: NaN },
      { open: undefined },
      { high: 7 },
      { close: 14 },
      { volume: -1 },
    ]) {
      expect(() => ohlcvFromBars([valid, { ...valid, ...change }] as never)).toThrow(
        expect.objectContaining({ name: 'InputError' }),
      );
    }
    expect(ohlcvFromBars([])).toEqual([]);
    expect(() => ohlcvFromBars(null as never)).toThrow(
      expect.objectContaining({ code: 'input.wrong_type' }),
    );
  });
});

it('refuses out-of-order, duplicate or cross-symbol sources before projection', () => {
  const first = { symbol: 'TEST', timestampMs: 1000, open: 10, high: 12, low: 8, close: 10 };
  for (const second of [
    { ...first, timestampMs: 500 },
    { ...first },
    { ...first, timestampMs: 2000, symbol: 'OTHER' },
  ]) {
    expect(() => ohlcvFromBars([first, second])).toThrow(
      expect.objectContaining({ name: 'InputError', code: 'input.out_of_range' }),
    );
  }
});

it('validates optional canonical metadata without inventing volume or adjustments', () => {
  const first = { symbol: 'TEST', timestampMs: 1000, open: 10, high: 12, low: 8, close: 10 };
  for (const change of [{ vwap: Infinity }, { vwap: '10' }, { adjusted: 'false' }]) {
    expect(() => ohlcvFromBars([{ ...first, ...change }] as never)).toThrow(
      expect.objectContaining({ name: 'InputError' }),
    );
  }
  expect(ohlcvFromBars([{ ...first, vwap: 10, adjusted: false }])).toEqual([
    { open: 10, high: 12, low: 8, close: 10 },
  ]);
});
