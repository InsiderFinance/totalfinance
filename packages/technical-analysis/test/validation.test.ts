import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type BarInput, SCHEMA_VERSION } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { register } from '@totalfinance/technical-analysis/registry';
import { movingAverage, mavp, pairs } from '@totalfinance/technical-analysis/statistics';
import { rescale } from '@totalfinance/technical-analysis/features';
import { rollingAnchoredVwap } from '@totalfinance/technical-analysis/overlap';
import { supportResistance } from '@totalfinance/technical-analysis/price-action';

const bars: BarInput[] = Array.from({ length: 20 }, (_, i) => ({
  open: 100 + i,
  high: 100 + i + 1,
  low: 100 + i - 1,
  close: 100 + i,
  volume: 100,
}));
const closes = bars.map((b) => b.close);

describe('chart-type guards (no infinite loops)', () => {
  it('renko throws on a non-positive / non-finite brick size instead of hanging', () => {
    for (const brickSize of [0, -1, NaN, Infinity]) {
      expect(() => ta.charts.renko(bars, { brickSize }), `brickSize=${brickSize}`).toThrowError(
        /brickSize/,
      );
    }
    // a valid brick still works
    expect(ta.charts.renko(bars, { brickSize: 1 }).length).toBeGreaterThan(0);
  });
  it('kagi / pointAndFigure / bar aggregations reject bad sizes', () => {
    expect(() => ta.charts.kagi(bars, { reversal: 0 })).toThrowError(/reversal/);
    expect(() => ta.charts.pointAndFigure(bars, { boxSize: 0 })).toThrowError(/boxSize/);
    expect(() => ta.charts.pointAndFigure(bars, { boxSize: 1, reversal: 0 })).toThrowError(
      /reversal/,
    );
    expect(() => ta.charts.rangeBars(bars, { size: -1 })).toThrowError(/size/);
    expect(() => ta.charts.tickBars(bars, { count: 0 })).toThrowError(/count/);
    expect(() => ta.charts.volumeBars(bars, { volume: 0 })).toThrowError(/volume/);
    expect(() => ta.charts.dollarBars(bars, { dollar: -5 })).toThrowError(/dollar/);
  });
});

describe('indicator period validation', () => {
  it('rejects zero / negative / non-integer / NaN periods with InputError', () => {
    for (const period of [0, -3, 2.5, NaN, Infinity]) {
      expect(() => ta.sma(closes, { period }), `sma ${period}`).toThrow();
      expect(() => ta.rsi(closes, { period }), `rsi ${period}`).toThrow();
      expect(() => ta.atr(bars, { period }), `atr ${period}`).toThrow();
      expect(() => ta.ema(closes, { period }), `ema ${period}`).toThrow();
    }
  });
  it('validates composed-indicator sub-periods (macd fast/slow/signal)', () => {
    expect(() => ta.macd(closes, { fast: 0 })).toThrow();
    expect(() => ta.macd(closes, { slow: -1 })).toThrow();
    expect(() => ta.macd(closes, { signal: 2.5 })).toThrow();
  });
  it('the thrown error is a typed InputError with an out-of-range code', () => {
    let caught: unknown;
    try {
      ta.sma(closes, { period: 0 });
    } catch (e) {
      caught = e;
    }
    expect((caught as { name?: string }).name).toMatch(/InputError|QuantError/);
    expect((caught as { code?: string }).code).toBe('input.out_of_range');
  });
  it('a valid period still computes', () => {
    expect(ta.sma(closes, { period: 5 })).toHaveLength(closes.length);
  });
});

describe('price-action guards', () => {
  it('breakouts rejects a non-positive lookback (no all-ones output)', () => {
    expect(() => ta.priceAction.breakouts(bars, { lookback: 0 })).toThrow();
    expect(() => ta.priceAction.breakouts(bars, { lookback: -5 })).toThrow();
  });
  it('opening-range breakout rejects a negative period (no raw TypeError)', () => {
    expect(() => ta.priceAction.openingRangeBreakout(bars, { periods: -1 })).toThrowError(
      /periods/,
    );
    expect(() => ta.priceAction.openingRange(bars, { periods: 0 })).toThrowError(/periods/);
  });
  it('sessionRanges rejects a sessionIds length mismatch', () => {
    expect(() => ta.priceAction.sessionRanges(bars, [0, 0, 1])).toThrowError(/length/);
  });
});

describe('signal DSL fails loud on unknown references', () => {
  it('throws on a misspelled column alias instead of returning all null', () => {
    expect(() =>
      ta
        .signal(bars)
        .sma('close', { period: 5 }, { as: 'fast' })
        .when(ta.crossOver('fast', 'slooow')) // typo
        .emit('x')
        .signals(),
    ).toThrowError(/unknown reference/);
  });
  it('throws on an unknown record sub-field', () => {
    expect(() =>
      ta
        .signal(bars)
        .feature('macd', ta.macd(closes, { fast: 2, slow: 4, signal: 2 }))
        .when(ta.gt('macd.notAField', 0))
        .emit('x')
        .signals(),
    ).toThrowError(/unknown reference/);
  });
  it('accepts raw OHLCV fields and valid dotted sub-fields', () => {
    const out = ta
      .signal(bars)
      .feature('macd', ta.macd(closes, { fast: 2, slow: 4, signal: 2 }))
      .when(ta.gt('close', 'open'))
      .and(ta.gt('macd.histogram', -1e9))
      .emit('ok')
      .signals();
    expect(out).toHaveLength(bars.length);
  });
});

describe('pipeline column-length validation', () => {
  it('rejects an injected column whose length does not match the bars', () => {
    expect(() => ta.features(bars).column('short', [1, 2, 3])).toThrowError(/length/);
  });
  it('accepts a correctly-sized injected column', () => {
    const cols = ta
      .features(bars)
      .column(
        'ones',
        bars.map(() => 1),
      )
      .toColumns();
    expect(cols['ones']).toHaveLength(bars.length);
  });
});

describe('registry uses the TotalFinance error model', () => {
  it('duplicate registration throws an InputError (not a raw Error)', () => {
    let caught: unknown;
    try {
      register({
        name: 'sma',
        category: 'custom',
        inputs: 'series',
        parameters: [],
        indicator: ta.sma,
        output: { value: { type: 'number' } },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('registry.duplicate_indicator');
  });
});

describe('sample-estimator correctness', () => {
  const series = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);

  it('standardDeviation/variance preserve `sample: true` across a snapshot restore (streaming parity)', () => {
    for (const name of ['standardDeviation', 'variance'] as const) {
      const parameters = { period: 10, sample: true };
      const ref = ta[name].stream(parameters);
      const expected = series.map((v) => ref.next(v));
      const part = ta[name].stream(parameters);
      for (let i = 0; i < 20; i++) part.next(series[i]!);
      const restored = ta[name].fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 20; i < series.length; i++) {
        const got = restored.next(series[i]!);
        if (expected[i] === null) expect(got, name).toBeNull();
        else expect(got as number, name).toBeCloseTo(expected[i] as number, 12);
      }
      // and the restored sample stream must differ from a population stream (proves the flag survived)
      const popLast = ta[name](series, { period: 10 }).at(-1)!;
      const sampleLast = ta[name](series, parameters).at(-1)!;
      expect(sampleLast).not.toBeCloseTo(popLast, 6);
    }
  });

  it('sample estimators reject period 1 (undefined ÷ (n−1)); population period 1 is allowed', () => {
    expect(() => ta.standardDeviation(series, { period: 1, sample: true })).toThrowError(/≥ 2/);
    expect(() => ta.variance(series, { period: 1, sample: true })).toThrowError(/≥ 2/);
    expect(() => ta.rollingVolatility(series, { period: 1, annualization: 1 })).toThrowError(/≥ 2/);
    expect(() => ta.historicalVolatility(series, { period: 1, annualization: 1 })).toThrowError(
      /≥ 2/,
    );
    // population stddev of a single value is a well-defined 0
    expect(ta.standardDeviation(series, { period: 1 }).at(-1)!).toBe(0);
  });
});

describe('tighter domain constraints', () => {
  const series = Array.from({ length: 40 }, (_, i) => 100 + i);
  const bars: BarInput[] = series.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c }));

  it('Bollinger standardDeviation must be positive (no upper < lower)', () => {
    expect(() => ta.bbands(series, { period: 5, standardDeviation: -2 })).toThrowError(
      /standardDeviation/,
    );
    expect(() => ta.bbands(series, { period: 5, standardDeviation: 0 })).toThrowError(
      /standardDeviation/,
    );
    expect(() => ta.bollingerBandWidth(series, { period: 5, standardDeviation: -1 })).toThrowError(
      /standardDeviation/,
    );
  });
  it('t3.volumeFactor and alma.offset are constrained to [0, 1]', () => {
    expect(() => ta.t3(series, { period: 5, volumeFactor: 1.5 })).toThrowError(/volumeFactor/);
    expect(() => ta.t3(series, { period: 5, volumeFactor: -0.1 })).toThrowError(/volumeFactor/);
    expect(() => ta.alma(series, { period: 9, offset: 2 })).toThrowError(/offset/);
    // valid values still work
    expect(ta.t3(series, { period: 5, volumeFactor: 0.7 })).toHaveLength(series.length);
  });
  it('Parabolic SAR rejects step > max', () => {
    expect(() => ta.psar(bars, { step: 0.3, max: 0.2 })).toThrowError(/step.*max/);
    expect(ta.psar(bars, { step: 0.02, max: 0.2 })).toHaveLength(bars.length);
  });
});

describe('signal DSL — scalar dotted refs and custom conditions', () => {
  const bars: BarInput[] = Array.from({ length: 20 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
  }));
  const closes = bars.map((b) => b.close);

  it('rejects a dotted ref into a scalar column', () => {
    expect(() =>
      ta
        .signal(bars)
        .feature('px', closes) // scalar column
        .when(ta.gt('px.foo', 0))
        .emit('x')
        .signals(),
    ).toThrowError(/unknown reference/);
  });

  it('condition() builds a custom predicate whose refs are validated', () => {
    // a valid custom condition reading a known column
    const out = ta
      .signal(bars)
      .sma('close', { period: 3 }, { as: 'fast' })
      .when(
        ta.condition(
          ['fast', 'close'],
          (context, i) => context.get('close', i) > context.get('fast', i),
        ),
      )
      .emit('above')
      .signals();
    expect(out).toHaveLength(bars.length);
    expect(out).toContain('above');
    // a custom condition referencing an unknown column still fails loud
    expect(() =>
      ta
        .signal(bars)
        .when(ta.condition(['nope'], () => true))
        .emit('x')
        .signals(),
    ).toThrowError(/unknown reference/);
  });
});

describe('string-union (enum) validation', () => {
  const series = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const bars: BarInput[] = series.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c }));

  it('macdExt rejects an invalid MA type with InputError (not a raw TypeError)', () => {
    let caught: unknown;
    try {
      ta.macdExt(series, { fastMovingAverageType: 'bogus' as never });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('input.out_of_range');
    expect(String((caught as Error).message)).toMatch(/fastMovingAverageType/);
    // a valid MA type still works
    expect(ta.macdExt(series, { fastMovingAverageType: 'wma' })).toHaveLength(series.length);
  });

  it('pipeline rejects an invalid field instead of producing an all-NaN column', () => {
    expect(() => ta.features(bars).sma('bogus' as never, { period: 5 })).toThrowError(/field/);
  });

  it('pivots rejects an invalid method instead of returning undefined', () => {
    expect(() => ta.priceAction.pivots(bars[0]!, 'bogus' as never)).toThrowError(/method/);
  });
});

describe('snapshot-restore robustness', () => {
  it('macdExt.fromJSON throws on an unknown MA snapshot kind (no silent EMA fallback)', () => {
    const s = ta.macdExt.stream({});
    [1, 2, 3, 4, 5, 6].forEach((v) => s.next(v));
    const snap = JSON.parse(JSON.stringify(s.toJSON())) as {
      state: Record<string, { kind: string }>;
    };
    snap.state['fast']!.kind = 'bogus';
    expect(() => ta.macdExt.fromJSON(snap as never)).toThrowError(/unknown MA snapshot kind/);
  });
});

describe('mama adaptive-limit constraints', () => {
  const bars: BarInput[] = Array.from({ length: 60 }, (_, i) => {
    const c = 100 + Math.sin(i / 4) * 5;
    return { open: c, high: c + 1, low: c - 1, close: c };
  });
  it('enforces 0 < slowLimit ≤ fastLimit ≤ 1', () => {
    expect(() => ta.mama(bars, { fastLimit: 1.5 })).toThrowError(/fastLimit/);
    expect(() => ta.mama(bars, { fastLimit: 0 })).toThrowError(/fastLimit/);
    expect(() => ta.mama(bars, { fastLimit: 0.5, slowLimit: 0.8 })).toThrowError(/slowLimit/);
    // sane defaults still compute
    expect(ta.mama(bars, {})).toHaveLength(bars.length);
  });
});

describe('volumeProfile param validation', () => {
  const bars: BarInput[] = Array.from({ length: 20 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 100,
  }));
  it('rejects bad bins (0 / NaN) and out-of-range valueAreaFraction', () => {
    expect(() => ta.volumeProfile(bars, { bins: 0 })).toThrowError(/bins/);
    expect(() => ta.volumeProfile(bars, { bins: NaN })).toThrowError(/bins/);
    expect(() => ta.volumeProfile(bars, { valueAreaFraction: 1.5 })).toThrowError(
      /valueAreaFraction/,
    );
    expect(ta.volumeProfile(bars, { bins: 10, valueAreaFraction: 0.7 }).bins).toHaveLength(10);
  });
});

describe('runtime-contract hardening (malformed inputs throw typed InputError)', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const periods = closes.map((_, i) => 2 + (i % 10));

  it('mavp rejects a period vector that does not match the series length', () => {
    expect(() => mavp({ series: closes, periods: [1, 2, 3] })).toThrowError(InputError);
    expect(() => mavp({ series: closes, periods: [1, 2, 3] })).toThrowError(/length/);
  });
  it('mavp rejects non-finite periods instead of silently skipping them', () => {
    expect(() => mavp({ series: closes, periods: closes.map(() => NaN) })).toThrowError(/periods/);
    expect(() => mavp({ series: closes, periods: closes.map(() => Infinity) })).toThrowError(
      /periods/,
    );
  });
  it('mavp rejects minPeriod > maxPeriod', () => {
    expect(() =>
      mavp({ series: closes, periods, parameters: { minPeriod: 30, maxPeriod: 5 } }),
    ).toThrowError(/minPeriod/);
  });
  it('mavp still computes for a well-formed call', () => {
    expect(
      mavp({ series: closes, periods, parameters: { minPeriod: 2, maxPeriod: 10 } }),
    ).toHaveLength(closes.length);
  });

  it('pairs throws on a length mismatch rather than truncating silently', () => {
    expect(() => pairs([1, 2, 3], [1, 2])).toThrowError(InputError);
    expect(() => pairs([1, 2, 3], [1, 2])).toThrowError(/length/);
    expect(pairs([1, 2, 3], [4, 5, 6])).toHaveLength(3);
  });

  it('ma.fromJSON throws on an unknown snapshot kind (no silent SMA fallback)', () => {
    expect(() =>
      movingAverage.fromJSON({
        kind: 'definitely-not-a-moving-average',
        schemaVersion: SCHEMA_VERSION,
        state: {},
      }),
    ).toThrowError(/unknown moving-average snapshot kind/);
  });

  it('rollingAnchoredVwap rejects an anchor outside { low, high }', () => {
    const bars: BarInput[] = closes.map((c) => ({
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1,
    }));
    expect(() => rollingAnchoredVwap(bars, { anchor: 'sideways' as never })).toThrowError(/anchor/);
    expect(rollingAnchoredVwap(bars, { lookback: 5, anchor: 'high' })).toHaveLength(bars.length);
  });

  it('rescale rejects min > max', () => {
    expect(() => rescale(closes, { min: 5, max: 1 })).toThrowError(InputError);
    expect(() => rescale(closes, { min: 5, max: 1 })).toThrowError(/min/);
    expect(rescale(closes, { period: 5, min: 0, max: 10 })).toHaveLength(closes.length);
  });

  it('supportResistance rejects a non-positive tolerance', () => {
    const bars: BarInput[] = closes.map((c) => ({
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1,
    }));
    expect(() => supportResistance(bars, { tolerance: 0 })).toThrowError(/tolerance/);
    expect(() => supportResistance(bars, { tolerance: -0.1 })).toThrowError(/tolerance/);
    expect(() => supportResistance(bars, { strength: 0 })).toThrowError(/strength/);
  });
});

describe('psarExt acceleration consistency', () => {
  const bars: BarInput[] = Array.from({ length: 30 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
  }));
  it('rejects a step acceleration greater than its max (matches psar posture)', () => {
    expect(() => ta.psarExt(bars, { accelLong: 0.5, accelMaxLong: 0.2 })).toThrowError(/accelLong/);
    expect(() => ta.psarExt(bars, { accelShort: 0.5, accelMaxShort: 0.2 })).toThrowError(
      /accelShort/,
    );
    expect(ta.psarExt(bars, {})).toHaveLength(bars.length);
  });
});

describe('Ichimoku echoes its displacement', () => {
  it('returns the (unshifted) components plus the displacement to apply', () => {
    const r = ta.ichimoku(bars, { conversion: 2, base: 3, spanB: 5, displacement: 26 }).at(-1)!;
    expect(r.displacement).toBe(26);
    expect(r.senkouA).toBeCloseTo((r.tenkan + r.kijun) / 2, 12);
    expect(r.chikou).toBe(bars.at(-1)!.close);
  });
});
