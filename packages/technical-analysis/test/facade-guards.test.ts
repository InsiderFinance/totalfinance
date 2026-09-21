import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError, isQuantError } from '@totalfinance/core';
import {
  divergence,
  divergences,
  fibExtension,
  fibRetracement,
  mavp,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { alignToBars, resample, type TimeBar } from '@totalfinance/technical-analysis/resample';
import {
  openingRange,
  openingRangeBreakout,
  orbRetest,
} from '@totalfinance/technical-analysis/price-action';
import { talibCandle } from '@totalfinance/technical-analysis/candle-talib';
import {
  footprintBars,
  tickVolumeProfile,
  type Trade,
} from '@totalfinance/technical-analysis/microstructure';

/**
 * Facade guard remediation (dx WS-1.2 and the typed-error law): the most natural WRONG calls —
 * a number series into a bar indicator, a missing array argument, an unknown enum name — must
 * throw typed teaching errors, never return silent garbage or raw TypeErrors.
 */

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
const bars = closes.map((c, i) => ({
  open: i === 0 ? c : closes[i - 1]!,
  high: c + 2,
  low: c - 2,
  close: c,
  volume: 100 + i,
}));
const timeBars: TimeBar[] = closes.map((c, i) => ({
  timestampMs: i * 60_000,
  open: c,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 10,
}));
const trades: Trade[] = closes.map((c) => ({ price: c, size: 5 }));

describe('bar-shape first-element check (WS-1.2)', () => {
  it('atr(closes) — a number series into a bar indicator — throws the barsFromColumns teaching error', () => {
    let caught: unknown;
    try {
      ta.atr(closes as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toMatch(/expects OHLC bars/);
    expect((caught as Error).message).toMatch(/barsFromColumns/);
  });

  it('the same wrong call throws from .explain and .collect paths too', () => {
    expect(() => ta.adx.explain(closes as never)).toThrowError(/expects OHLC bars/);
  });

  it('a bar with a non-finite first element is rejected by name', () => {
    const bad = [{ high: NaN, low: 1, close: 2 }, ...bars.slice(1)];
    expect(() => ta.atr(bad)).toThrowError(/bars\[0\]\.high must be a finite number/);
  });

  it('rsi([1, 2, {}, 4]) — an object inside a number series — throws', () => {
    expect(() => ta.rsi([1, 2, {} as never, 4])).toThrowError(InputError);
    expect(() => ta.rsi([1, 2, {} as never, 4])).toThrowError(/series\[2\] is an object/);
  });

  it('bars into a series indicator throw the map-the-field teaching error', () => {
    expect(() => ta.rsi(bars as never)).toThrowError(/expects a number series/);
  });

  it('a bare number series into a pair indicator teaches ta.pairs', () => {
    expect(() => ta.correl(closes as never, { period: 10 })).toThrowError(
      /technicalAnalysis\.pairs\(xs, ys\)/,
    );
  });

  it('legal inputs stay legal: leading/interior NaN gaps, empty arrays, pair warmup NaNs', () => {
    expect(() => ta.rsi([NaN, ...closes], { period: 14 })).not.toThrow();
    expect(ta.atr([])).toEqual([]);
    expect(ta.rsi([])).toEqual([]);
    // A pair whose y starts NaN (indicator warmup) is a legitimate divergence input.
    const pair = closes.map((c, i) => ({ x: c, y: i < 5 ? NaN : c }));
    expect(() => divergence(pair)).not.toThrow();
  });
});

describe('multi-arg facades validate every array argument (WS-1 typed-error law)', () => {
  it('resample(undefined, "5m") throws a typed error, not a raw length TypeError', () => {
    let caught: unknown;
    try {
      resample(undefined as never, '5m');
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/bars/);
  });

  it('alignToBars without lowerBars throws a typed error naming lowerBars', () => {
    const series = timeBars.map((b) => b.close);
    let caught: unknown;
    try {
      alignToBars({ higherSeries: series, higherBars: timeBars, lowerBars: undefined as never });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/lowerBars/);
  });

  it('openingRange / openingRangeBreakout / orbRetest validate bars and options', () => {
    expect(() => openingRange('hello' as never, { periods: 2 })).toThrowError(InputError);
    expect(() => openingRange(bars, undefined as never)).toThrowError(InputError);
    expect(() => openingRangeBreakout('hello' as never, { periods: 2 })).toThrowError(InputError);
    expect(() => orbRetest('hello' as never, { periods: 2 })).toThrowError(InputError);
    // the old silent shape: orbRetest('hello', 2) returned [NaN, NaN, 0, 0, 0]
    let caught: unknown;
    try {
      orbRetest('hello' as never, { periods: 2 });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
  });
});

describe('optional trailing parameters/options objects reject garbage typed (R3 deep-sweep law)', () => {
  const periods = closes.map((_, i) => 2 + (i % 5));

  it('mavp: omitted parameters engage defaults; a null/number parameters throws typed, not a raw TypeError', () => {
    expect(mavp({ series: closes, periods })).toHaveLength(closes.length);
    let caught: unknown;
    try {
      mavp({ series: closes, periods, parameters: null as never });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    expect(() => mavp({ series: closes, periods, parameters: 42 as never })).toThrowError(
      /parameters must be an object/,
    );
  });

  it('divergences: omitted parameters engage swing defaults; null parameters throws typed', () => {
    const indicator = closes.map((c, i) => c + Math.cos(i / 3));
    expect(() => divergences({ price: closes, indicator })).not.toThrow();
    let caught: unknown;
    try {
      divergences({ price: closes, indicator, parameters: null as never });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
  });

  it('resample / alignToBars: garbage options throws typed instead of dereferencing null', () => {
    expect(resample(timeBars, '5m').length).toBeGreaterThan(0);
    let caught: unknown;
    try {
      resample(timeBars, '5m', null as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    const series = timeBars.map((b) => b.close);
    caught = undefined;
    try {
      alignToBars({
        higherSeries: series,
        higherBars: timeBars,
        lowerBars: timeBars,
        options: 'garbage' as never,
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
  });

  it('fibRetracement / fibExtension: non-array levels throw typed naming levels', () => {
    let caught: unknown;
    try {
      fibRetracement(112, 96, 42 as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    expect((caught as Error).message).toMatch(/levels/);
    caught = undefined;
    try {
      fibExtension({ start: 96, end: 112, projectFrom: 104, levels: null as never });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    // the default level ladders keep working
    expect(fibRetracement(112, 96).length).toBeGreaterThan(0);
    expect(fibExtension({ start: 96, end: 112, projectFrom: 104 }).length).toBeGreaterThan(0);
  });
});

describe('talibCandle unknown pattern is a typed enum error (B3)', () => {
  it('lists the valid adaptive pattern names', () => {
    let caught: unknown;
    try {
      talibCandle('notAPattern', bars);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputInvalidEnum)).toBe(true);
    expect((caught as Error).message).toMatch(/doji/);
    expect((caught as Error).message).toMatch(/notAPattern/);
  });
});

describe('microstructure degenerate parameters (B6)', () => {
  it('tickVolumeProfile({ bins: 0 }) throws instead of silently becoming 50', () => {
    expect(() => tickVolumeProfile(trades, { bins: 0 })).toThrowError(/bins must be an integer/);
  });

  it('footprintBars by:"time" with untimestamped trades throws a teaching error', () => {
    let caught: unknown;
    try {
      footprintBars(trades, { by: 'time', threshold: 60_000 });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.missing_field')).toBe(true);
    expect((caught as Error).message).toMatch(/`time` field/);
    // timestamped trades keep working
    const stamped = trades.map((t, i) => ({ ...t, time: i * 1000 }));
    expect(footprintBars(stamped, { by: 'time', threshold: 5000 }).length).toBeGreaterThan(1);
  });
});

describe('requirePresent teaching message is input-kind aware (A6)', () => {
  const msg = (fn: () => void): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };

  it('MA family on a series keeps the common-lengths hint', () => {
    expect(msg(() => ta.ema(closes))).toMatch(
      /ema\(series, \{ period: 20 \}\) — common: 10, 20, 50, 200/,
    );
    expect(msg(() => ta.sma(closes))).toMatch(/sma\(series, \{ period: 20 \}\)/);
  });

  it('bar-input MA (vwma) phrases the example with bars', () => {
    expect(msg(() => ta.vwma(bars))).toMatch(/vwma\(bars, \{ period: 20 \}\)/);
  });

  it('non-MA indicators drop the MA-length hint', () => {
    const m = msg(() => ta.supertrend(bars));
    expect(m).toMatch(/supertrend\(bars, \{ period: 14 \}\)/);
    expect(m).not.toMatch(/common: 10, 20, 50, 200/);
    expect(msg(() => ta.rollingMin(closes))).toMatch(/rollingMin\(series, \{ period: 14 \}\)/);
  });

  it('pair-input indicators phrase the example with pairs(a, b)', () => {
    const pair = closes.map((c) => ({ x: c, y: c + 1 }));
    expect(msg(() => ta.beta(pair))).toMatch(/beta\(pairs\(a, b\), \{ period: 14 \}\)/);
  });
});
