import { describe, expect, it } from 'vitest';
import {
  type BarInput,
  type Indicator,
  type TechnicalAnalysisSnapshot,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { SmaStream } from '@totalfinance/technical-analysis/moving-averages';

const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.15);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.2,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 100 + (i % 7) * 10,
}));

// Indicators that take a plain number series and a { period }.
const seriesMAs = [
  'sma',
  'ema',
  'wma',
  'rma',
  'dema',
  'tema',
  'trima',
  'hma',
  'zlema',
  'mcginley',
  'superSmoother',
] as const;
// Bar-series MAs keyed by close price.
const barMAs = ['vwma', 'rollingVwap', 'frama'] as const;

describe('moving-average constant-series invariant', () => {
  const flat = Array.from({ length: 60 }, () => 42);
  const flatBars: BarInput[] = flat.map((c) => ({
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 10,
  }));

  it('every number-series MA of a constant series equals that constant', () => {
    for (const name of seriesMAs) {
      const out = ta[name](flat, { period: 10 }).at(-1)!;
      expect(out, name).toBeCloseTo(42, 8);
    }
    expect(ta.t3(flat, { period: 5 }).at(-1)!).toBeCloseTo(42, 8);
    expect(ta.kama(flat, { period: 10 }).at(-1)!).toBeCloseTo(42, 8);
    expect(ta.alma(flat, { period: 9 }).at(-1)!).toBeCloseTo(42, 8);
    expect(ta.vidya(flat, { period: 9 }).at(-1)!).toBeCloseTo(42, 8);
  });

  it('every bar MA of a constant series equals that constant', () => {
    for (const name of barMAs) {
      expect(ta[name](flatBars, { period: 8 }).at(-1)!, name).toBeCloseTo(42, 8);
    }
    expect(ta.anchoredVwap(flatBars, { anchor: 3 }).at(-1)!).toBeCloseTo(42, 8);
    const m = ta.mama(flatBars, {}).at(-1)!;
    expect(m.mama).toBeCloseTo(42, 6);
    expect(m.fama).toBeCloseTo(42, 6);
  });
});

describe('specific formulas', () => {
  it('RMA seeds with the SMA of the first period then smooths (Wilder)', () => {
    const r = ta.rma.explain([1, 2, 3, 4, 5], { period: 3 });
    expect(r.diagnostics.warmup).toBe(2);
    expect(r.value[2]).toBeCloseTo(2, 12); // (1+2+3)/3
    expect(r.value[3]).toBeCloseTo((2 * 2 + 4) / 3, 12); // (prev*(n-1)+x)/n
    expect(r.value[4]).toBeCloseTo((((2 * 2 + 4) / 3) * 2 + 5) / 3, 12);
  });

  it('TRIMA uses triangular weights', () => {
    expect(ta.trima([1, 2, 3], { period: 3 }).at(-1)!).toBeCloseTo(8 / 4, 12); // (1·1+2·2+3·1)/4
    expect(ta.trima([1, 2, 3, 4], { period: 4 }).at(-1)!).toBeCloseTo(15 / 6, 12); // [1,2,2,1]
  });

  it('VWMA equals SMA when volume is constant', () => {
    const equalVolatility: BarInput[] = closes.map((c) => ({
      high: c,
      low: c,
      close: c,
      volume: 100,
    }));
    const v = ta.vwma(equalVolatility, { period: 10 });
    const s = ta.sma(closes, { period: 10 });
    for (let i = 0; i < closes.length; i++) {
      if (!Number.isNaN(s[i]!)) expect(v[i]!).toBeCloseTo(s[i]!, 10);
    }
  });

  it('DEMA/TEMA cancel the constant lag EMA leaves on a linear ramp', () => {
    const ramp = Array.from({ length: 40 }, (_, i) => i);
    const last = ramp.at(-1)!;
    const ema = ta.ema(ramp, { period: 10 }).at(-1)!;
    const dema = ta.dema(ramp, { period: 10 }).at(-1)!;
    const tema = ta.tema(ramp, { period: 10 }).at(-1)!;
    expect(Math.abs(ema - last)).toBeGreaterThan(0.5); // EMA lags a trend
    expect(Math.abs(dema - last)).toBeLessThan(1e-6); // DEMA removes the constant lag exactly
    expect(Math.abs(tema - last)).toBeLessThan(1e-6); // TEMA likewise
  });

  it('KAMA warms up at `period` and stays within the price envelope', () => {
    const r = ta.kama.explain(closes, { period: 10 });
    expect(r.diagnostics.warmup).toBe(10);
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    for (let i = r.diagnostics.warmup; i < closes.length; i++) {
      expect(r.value[i]!).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(r.value[i]!).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  it('anchored VWAP is null before the anchor and accumulates after', () => {
    const r = ta.anchoredVwap.explain(bars, { anchor: 5 });
    expect(r.diagnostics.warmup).toBe(5);
    for (let i = 0; i < 5; i++) expect(r.value[i]).toBeNaN();
    expect(Number.isFinite(r.value[5]!)).toBe(true);
  });

  it('Hull MA tracks a ramp with near-zero lag', () => {
    const ramp = Array.from({ length: 40 }, (_, i) => i);
    expect(ta.hma(ramp, { period: 9 }).at(-1)!).toBeCloseTo(39, 0);
  });
});

describe('moving-average streaming parity', () => {
  function parity(ind: Indicator<{ period: number }, number, number>, period: number): void {
    const batch = ind.explain(closes, { period });
    const stream = ind.stream({ period });
    for (let i = 0; i < closes.length; i++) {
      const e = stream.next(closes[i]!);
      if (i < batch.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toBeCloseTo(batch.value[i]!, 9);
    }
  }
  it('all number-series MAs match their streams', () => {
    for (const name of seriesMAs) parity(ta[name], 12);
  });

  it('snapshot round-trips for an adaptive MA (KAMA) and composed MA (TEMA)', () => {
    for (const [ind, parameters] of [
      [ta.kama, { period: 10 }],
      [ta.tema, { period: 8 }],
    ] as const) {
      const ref = ind.stream(parameters);
      const expected = closes.map((c) => ref.next(c));
      const part = ind.stream(parameters);
      for (let i = 0; i < 30; i++) part.next(closes[i]!);
      const snap: TechnicalAnalysisSnapshot = JSON.parse(JSON.stringify(part.toJSON()));
      const restored = ind.fromJSON(snap);
      for (let i = 30; i < closes.length; i++) {
        const got = restored.next(closes[i]!);
        if (expected[i] === null) expect(got).toBeNull();
        else expect(got!).toBeCloseTo(expected[i]!, 9);
      }
    }
  });

  it('rejects an SMA snapshot whose rolling buffer exceeds its period before reading elements', () => {
    const snapshot = ta.sma.stream({ period: 2 }).toJSON() as unknown as {
      state: { buf: number[]; sum: number };
    };
    snapshot.state.buf = [1, 2, 3];
    snapshot.state.sum = 6;
    Object.defineProperty(snapshot.state.buf, 0, {
      get: () => {
        throw new Error('buffer element was touched before the period invariant');
      },
    });
    expect(() => SmaStream.fromJSON(snapshot as never)).toThrowError(/exceeds its period 2/);
  });

  it('MAMA/FAMA and FRAMA stream-match their batch (bar inputs)', () => {
    const mb = ta.mama.explain(bars, {});
    const ms = ta.mama.stream({});
    for (let i = 0; i < bars.length; i++) {
      const e = ms.next(bars[i]!);
      if (i < mb.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(mb.value[i]);
    }
    const fb = ta.frama.explain(bars, { period: 16 });
    const fs = ta.frama.stream({ period: 16 });
    for (let i = 0; i < bars.length; i++) {
      const e = fs.next(bars[i]!);
      if (i < fb.diagnostics.warmup) expect(e).toBeNull();
      else expect(e!).toBeCloseTo(fb.value[i]!, 9);
    }
  });
});
