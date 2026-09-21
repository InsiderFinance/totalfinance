import { describe, expect, it } from 'vitest';
import { type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 12 + i * 0.05);

describe('Relative Volatility Index & inertia', () => {
  it('RVI ∈ [0, 100]; 100 on a strictly rising series', () => {
    for (const v of ta.relativeVolatilityIndex(closes, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    const rising = Array.from({ length: 40 }, (_, i) => 10 + i);
    expect(ta.relativeVolatilityIndex(rising, { period: 14 }).at(-1)!).toBeCloseTo(100, 9);
  });
  it('inertia (linreg of RVI) is finite after warmup', () => {
    const r = ta.inertia.explain(closes, { period: 20, rviPeriod: 14 });
    expect(Number.isFinite(r.value[r.value.length - 1] as number)).toBe(true);
  });
});

describe('Laguerre RSI', () => {
  it('is bounded in [0, 1]', () => {
    for (const v of ta.laguerreRsi(closes, { gamma: 0.5 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  it('rejects gamma outside [0, 1]', () => {
    expect(() => ta.laguerreRsi(closes, { gamma: 1.5 })).toThrowError(/gamma/);
    expect(() => ta.laguerreRsi(closes, { gamma: -0.1 })).toThrowError(/gamma/);
  });
});

describe('QQE', () => {
  it('rsiMovingAverage ∈ [0, 100] with longBand ≤ rsiMovingAverage ≤ shortBand', () => {
    for (const p of ta.qqe(closes, {})) {
      if (!Number.isNaN(p.rsiMovingAverage)) {
        expect(p.rsiMovingAverage).toBeGreaterThanOrEqual(0);
        expect(p.rsiMovingAverage).toBeLessThanOrEqual(100);
        expect(p.longBand).toBeLessThanOrEqual(p.rsiMovingAverage + 1e-9);
        expect(p.shortBand).toBeGreaterThanOrEqual(p.rsiMovingAverage - 1e-9);
      }
    }
  });
});

describe('RSX & Schaff Trend Cycle are bounded in [0, 100]', () => {
  it('RSX', () => {
    for (const v of ta.rsx(closes, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
  it('Schaff Trend Cycle', () => {
    for (const v of ta.schaffTrendCycle(closes, {})) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('streaming parity & snapshots', () => {
  it('scalar oscillators match their streams', () => {
    for (const name of [
      'relativeVolatilityIndex',
      'inertia',
      'laguerreRsi',
      'rsx',
      'schaffTrendCycle',
    ] as const) {
      const ind = ta[name] as Indicator<Record<string, never>, number, number>;
      const batch = ind.explain(closes, {});
      const stream = ind.stream({});
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
  });
  it('QQE record stream matches batch', () => {
    const batch = ta.qqe.explain(closes, {});
    const stream = ta.qqe.stream({});
    for (let i = 0; i < closes.length; i++) {
      const e = stream.next(closes[i]!);
      if (i < batch.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(batch.value[i]);
    }
  });
  it('snapshot round-trips QQE, Schaff and Laguerre', () => {
    for (const name of ['qqe', 'schaffTrendCycle', 'laguerreRsi'] as const) {
      const ref = ta[name].stream({});
      const expected = closes.map((c) => ref.next(c));
      const part = ta[name].stream({});
      for (let i = 0; i < 120; i++) part.next(closes[i]!);
      const restored = ta[name].fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 120; i < closes.length; i++) {
        const got = restored.next(closes[i]!);
        if (expected[i] === null) expect(got, name).toBeNull();
        else expect(got, name).toEqual(expected[i]);
      }
    }
  });
});
