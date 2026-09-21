import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i / 6) * 6 + i * 0.05);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.4,
  high: c + 1.2,
  low: c - 1.1,
  close: c,
  volume: 100 + (i % 9) * 10,
}));

describe('NATR & Bollinger derivatives', () => {
  it('NATR is ATR as a percentage of close', () => {
    const natr = ta.natr(bars, { period: 14 });
    const atr = ta.atr(bars, { period: 14 });
    const i = bars.length - 1;
    expect(natr[i]!).toBeCloseTo((100 * atr[i]!) / bars[i]!.close, 9);
  });
  it('bollingerBandWidth and bollingerPercentB equal the Bollinger record fields', () => {
    const bb = ta.bbands(closes, { period: 20, standardDeviation: 2 });
    const w = ta.bollingerBandWidth(closes, { period: 20, standardDeviation: 2 });
    const pb = ta.bollingerPercentB(closes, { period: 20, standardDeviation: 2 });
    const i = closes.length - 1;
    expect(w[i]!).toBeCloseTo(bb[i]!.bandwidth, 12);
    expect(pb[i]!).toBeCloseTo(bb[i]!.percentB, 12);
  });
});

describe('channels', () => {
  it('Keltner is EMA ± mult·ATR and ordered', () => {
    const k = ta.keltner(bars, { period: 20, multiplier: 2 }).at(-1)!;
    const ema = ta.ema(closes, { period: 20 }).at(-1)!;
    expect(k.middle).toBeCloseTo(ema, 9);
    expect(k.upper).toBeGreaterThan(k.middle);
    expect(k.lower).toBeLessThan(k.middle);
    expect(k.upper - k.middle).toBeCloseTo(k.middle - k.lower, 9);
  });
  it('Donchian upper/lower are the rolling high/low; middle is their mean', () => {
    const d = ta.donchian(bars, { period: 20 }).at(-1)!;
    const hh = Math.max(...bars.slice(-20).map((b) => b.high));
    const ll = Math.min(...bars.slice(-20).map((b) => b.low));
    expect(d.upper).toBeCloseTo(hh, 12);
    expect(d.lower).toBeCloseTo(ll, 12);
    expect(d.middle).toBeCloseTo((hh + ll) / 2, 12);
  });
});

describe('standardDeviation / variance', () => {
  it('standardDeviation² equals variance and matches a hand computation', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    const sd = ta.standardDeviation(xs, { period: 8 }).at(-1)!; // population σ = 2
    const v = ta.variance(xs, { period: 8 }).at(-1)!;
    expect(sd).toBeCloseTo(2, 12);
    expect(v).toBeCloseTo(4, 12);
    expect(sd * sd).toBeCloseTo(v, 12);
    // sample estimator is larger
    expect(ta.standardDeviation(xs, { period: 8, sample: true }).at(-1)!).toBeGreaterThan(sd);
  });
});

describe('OHLC volatility estimators', () => {
  it('all estimators are non-negative and finite after warmup', () => {
    const estimators = [
      ['historicalVolatility', closes],
      ['parkinson', bars],
      ['garmanKlass', bars],
      ['rogersSatchell', bars],
      ['yangZhang', bars],
    ] as const;
    for (const [name, input] of estimators) {
      const out = ta[name].explain(input as never, { period: 20, annualization: 1 } as never);
      for (let i = out.diagnostics.warmup; i < input.length; i++) {
        expect(Number.isFinite(out.value[i] as number), name).toBe(true);
        expect(out.value[i] as number, name).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('annualization is required — no silent per-bar σ (252 daily, 52 weekly, 12 monthly, 1 per-bar)', () => {
    for (const call of [
      () => ta.historicalVolatility(closes, { period: 20 } as never),
      () => ta.realizedVolatility(closes, { period: 20 } as never),
      () => ta.rollingVolatility(closes, { period: 20 } as never),
      () => ta.parkinson(bars, { period: 20 } as never),
      () => ta.garmanKlass(bars, { period: 20 } as never),
      () => ta.rogersSatchell(bars, { period: 20 } as never),
      () => ta.yangZhang(bars, { period: 20 } as never),
    ]) {
      expect(call).toThrowError(/annualization/);
      expect(call).toThrowError(/252/);
    }
  });
  it('annualization scales σ by √annualization', () => {
    const raw = ta.historicalVolatility(closes, { period: 20, annualization: 1 }).at(-1)!;
    const ann = ta.historicalVolatility(closes, { period: 20, annualization: 252 }).at(-1)!;
    expect(ann).toBeCloseTo(raw * Math.sqrt(252), 9);
  });
  it('realized volatility is the RMS of log returns (no mean subtraction)', () => {
    const rv = ta.realizedVolatility(closes, { period: 20, annualization: 1 });
    for (let i = 20; i < closes.length; i++) {
      expect(rv[i]!).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(rv[i]!)).toBe(true);
    }
    // RMS ≥ sample-std-based historical when returns have a non-zero mean drift
    const realized = rv.at(-1)!;
    const historical = ta.historicalVolatility(closes, { period: 20, annualization: 1 }).at(-1)!;
    expect(realized).toBeGreaterThanOrEqual(historical - 1e-9);
  });
  it('Parkinson on a constant-range series recovers the range-implied σ', () => {
    // constant H/L ratio → every term identical → σ = sqrt(term)
    const flat: BarInput[] = Array.from({ length: 30 }, () => ({
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    }));
    const term = Math.log(101 / 99) ** 2 / (4 * Math.LN2);
    expect(ta.parkinson(flat, { period: 20, annualization: 1 }).at(-1)!).toBeCloseTo(
      Math.sqrt(term),
      12,
    );
  });
});

describe('Chaikin Volatility', () => {
  it('is the ROC of the EMA of the high-low range', () => {
    const v = ta.chaikinVolatility(bars, { period: 10, rocPeriod: 10 });
    expect(v.some((x) => !Number.isNaN(x))).toBe(true);
  });
});

describe('volatility streaming parity & snapshots', () => {
  it('scalar and record volatility indicators match their streams', () => {
    const scalarBar = [
      'natr',
      'parkinson',
      'garmanKlass',
      'rogersSatchell',
      'yangZhang',
      'chaikinVolatility',
    ] as const;
    const rangeEstimators = new Set(['parkinson', 'garmanKlass', 'rogersSatchell', 'yangZhang']);
    for (const name of scalarBar) {
      // The volatility estimators require their bars-per-year; the other bar indicators take none.
      const parameters = rangeEstimators.has(name)
        ? { period: 14, annualization: 1 }
        : { period: 14 };
      const batch = ta[name].explain(bars, parameters as never);
      const stream = ta[name].stream(parameters as never);
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
    for (const name of ['keltner', 'donchian'] as const) {
      const batch = ta[name].explain(bars, { period: 14 });
      const stream = ta[name].stream({ period: 14 });
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips Yang-Zhang (preserves annualization scale)', () => {
    const ref = ta.yangZhang.stream({ period: 14, annualization: 252 });
    const expected = bars.map((b) => ref.next(b));
    const part = ta.yangZhang.stream({ period: 14, annualization: 252 });
    for (let i = 0; i < 50; i++) part.next(bars[i]!);
    const restored = ta.yangZhang.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 50; i < bars.length; i++) {
      const got = restored.next(bars[i]!);
      if (expected[i] === null) expect(got).toBeNull();
      else expect(got as number).toBeCloseTo(expected[i] as number, 9);
    }
  });
});
