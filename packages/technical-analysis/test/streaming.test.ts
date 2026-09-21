import { describe, expect, it } from 'vitest';
import { type BarInput, type IndicatorStream } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.2);
const bars: BarInput[] = closes.map((c, i) => ({
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 100 + i,
}));

function assertEquivalence<In, Out>(
  batchIn: { value: Out[]; warmup: number } | { value: Out[]; diagnostics: { warmup: number } },
  stream: IndicatorStream<In, Out>,
  input: ArrayLike<In>,
): void {
  const batch = {
    value: batchIn.value,
    warmup: 'warmup' in batchIn ? batchIn.warmup : batchIn.diagnostics.warmup,
  };
  for (let i = 0; i < input.length; i++) {
    const emitted = stream.next(input[i]!);
    if (i < batch.warmup) {
      expect(emitted).toBeNull();
    } else {
      expect(emitted).toEqual(batch.value[i]);
    }
  }
}

describe('streaming output matches batch after warmup', () => {
  it('SMA / EMA / WMA / RSI', () => {
    assertEquivalence(
      ta.sma.explain(closes, { period: 10 }),
      ta.sma.stream({ period: 10 }),
      closes,
    );
    assertEquivalence(
      ta.ema.explain(closes, { period: 10 }),
      ta.ema.stream({ period: 10 }),
      closes,
    );
    assertEquivalence(
      ta.wma.explain(closes, { period: 10 }),
      ta.wma.stream({ period: 10 }),
      closes,
    );
    assertEquivalence(
      ta.rsi.explain(closes, { period: 14 }),
      ta.rsi.stream({ period: 14 }),
      closes,
    );
  });

  it('MACD / Bollinger (record outputs)', () => {
    assertEquivalence(ta.macd.explain(closes, {}), ta.macd.stream({}), closes);
    assertEquivalence(
      ta.bbands.explain(closes, { period: 20 }),
      ta.bbands.stream({ period: 20 }),
      closes,
    );
  });

  it('ATR / Stochastic / ADX / VWAP / OBV (bar inputs)', () => {
    assertEquivalence(ta.atr.explain(bars, { period: 5 }), ta.atr.stream({ period: 5 }), bars);
    assertEquivalence(
      ta.stochastic.explain(bars, { kPeriod: 5, dPeriod: 3 }),
      ta.stochastic.stream({ kPeriod: 5, dPeriod: 3 }),
      bars,
    );
    assertEquivalence(ta.adx.explain(bars, { period: 5 }), ta.adx.stream({ period: 5 }), bars);
    assertEquivalence(ta.vwap.explain(bars, {}), ta.vwap.stream({}), bars);
    assertEquivalence(ta.obv.explain(bars, {}), ta.obv.stream({}), bars);
  });
});

describe('serializable streaming state', () => {
  it('resumes identically from a JSON snapshot', () => {
    const half = 25;
    const referenceRsi = ta.rsi.stream({ period: 14 });
    const ref = closes.map((c) => referenceRsi.next(c));

    const part = ta.rsi.stream({ period: 14 });
    for (let i = 0; i < half; i++) part.next(closes[i]!);
    const snapshot = JSON.parse(JSON.stringify(part.toJSON()));
    const restored = ta.rsi.fromJSON(snapshot);
    for (let i = half; i < closes.length; i++) {
      expect(restored.next(closes[i]!)).toEqual(ref[i]);
    }
  });

  it('round-trips a bar-indicator (ADX) snapshot', () => {
    const refStream = ta.adx.stream({ period: 5 });
    const ref = bars.map((b) => refStream.next(b));
    const part = ta.adx.stream({ period: 5 });
    const half = 4;
    for (let i = 0; i < half; i++) part.next(bars[i]!);
    const restored = ta.adx.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = half; i < bars.length; i++) {
      expect(restored.next(bars[i]!)).toEqual(ref[i]);
    }
  });
});

describe('feature pipeline', () => {
  it('builds aliased feature columns', () => {
    const cols = ta
      .features(bars)
      .sma('close', { period: 10 }, { as: 'fast' })
      .rsi('close', { period: 14 }, { as: 'momentum' })
      .vwap({ as: 'vwap' })
      .toColumns();
    expect(Object.keys(cols)).toEqual(['fast', 'momentum', 'vwap']);
    expect(cols['fast']!.length).toBe(bars.length);

    const rows = ta.features(bars).sma('close', { period: 10 }, { as: 'fast' }).toRows();
    expect(rows.length).toBe(bars.length);
    expect(rows[bars.length - 1]).toHaveProperty('fast');
  });

  it('throws on duplicate aliases', () => {
    expect(() =>
      ta
        .features(bars)
        .sma('close', { period: 10 }, { as: 'x' })
        .ema('close', { period: 5 }, { as: 'x' }),
    ).toThrowError(/Duplicate pipeline alias/);
  });
});
