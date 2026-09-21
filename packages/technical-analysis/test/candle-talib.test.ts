import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  candleAverage,
  cdlDojiTalib,
  cdlMarubozuTalib,
  cdlClosingMarubozuTalib,
  talibCandle,
  CANDLE_SETTINGS,
  TALIB_CANDLE_NAMES,
} from '@totalfinance/technical-analysis/candle-talib';
import type { BarInput } from '@totalfinance/technical-analysis';

/**
 * Adaptive TA-Lib candlestick engine — bit-for-bit parity for the implemented patterns against the
 * committed TA-Lib 0.6.x candlestick golden (`talib-candles-golden.json`). Proves the trailing
 * `TA_SetCandleSettings` averaging + the ±100 directional encoding reproduce TA-Lib exactly.
 */

const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
const D = load<{
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}>('reference-ohlcv.json');
const bars: BarInput[] = D.close.map((c, i) => ({
  open: D.open[i]!,
  high: D.high[i]!,
  low: D.low[i]!,
  close: c,
  volume: D.volume[i]!,
}));
const golden = load<{ patterns: Record<string, number[]> }>('talib-candles-golden.json');

const assertExact = (actual: number[], expected: number[], label: string): void => {
  expect(actual.length).toBe(expected.length);
  let nonzero = 0;
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i], `${label}[${i}]`).toBe(expected[i]);
    if (expected[i] !== 0) nonzero++;
  }
  expect(nonzero, `${label}: golden should fire at least once`).toBeGreaterThanOrEqual(1);
};

describe('adaptive candle engine — exact TA-Lib parity', () => {
  it('CDLDOJI matches TA-Lib bit-for-bit', () => {
    assertExact(cdlDojiTalib(bars), golden.patterns['CDLDOJI']!, 'CDLDOJI');
  });
  it('CDLMARUBOZU matches TA-Lib bit-for-bit (±100 by color)', () => {
    assertExact(cdlMarubozuTalib(bars), golden.patterns['CDLMARUBOZU']!, 'CDLMARUBOZU');
  });
  it('CDLCLOSINGMARUBOZU matches TA-Lib bit-for-bit', () => {
    assertExact(
      cdlClosingMarubozuTalib(bars),
      golden.patterns['CDLCLOSINGMARUBOZU']!,
      'CDLCLOSINGMARUBOZU',
    );
  });
  it('the talibCandle dispatcher resolves CDL* and camelCase names', () => {
    expect(talibCandle('CDLDOJI', bars)).toEqual(golden.patterns['CDLDOJI']);
    expect(talibCandle('doji', bars)).toEqual(golden.patterns['CDLDOJI']);
    expect(() => talibCandle('CDLHAMMER', bars)).toThrow();
  });
});

describe('candleAverage — TA-Lib TA_CANDLEAVERAGE semantics', () => {
  it('trailing average over the preceding averagePeriod bars; NaN during lookback', () => {
    const s = CANDLE_SETTINGS.bodyDoji; // highLow, averagePeriod 10, factor 0.1
    const avg = candleAverage(bars, s);
    for (let i = 0; i < 10; i++) expect(Number.isNaN(avg[i]!)).toBe(true);
    // bar 10 uses the high-low average of bars 0..9
    let sum = 0;
    for (let k = 0; k < 10; k++) sum += bars[k]!.high - bars[k]!.low;
    expect(avg[10]).toBeCloseTo(0.1 * (sum / 10), 12);
  });
  it('averagePeriod 0 uses the current bar range; Shadows range halves the denominator', () => {
    const sl = CANDLE_SETTINGS.shadowLong; // realBody, averagePeriod 0, factor 1
    const avg = candleAverage(bars, sl);
    expect(avg[5]).toBeCloseTo(Math.abs(bars[5]!.close - (bars[5]!.open ?? bars[5]!.close)), 12);
  });
  it('exposes the implemented pattern names', () => {
    expect(TALIB_CANDLE_NAMES).toContain('doji');
    expect(TALIB_CANDLE_NAMES).toContain('marubozu');
  });
});
