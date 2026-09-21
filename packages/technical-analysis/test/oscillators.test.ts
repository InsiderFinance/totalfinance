import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { KstStream } from '@totalfinance/technical-analysis/oscillators';

const closes = Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 100 + (i % 5) * 20,
}));

describe('ROC family & momentum', () => {
  it('match their definitions over a 1-bar lookback', () => {
    const p = [10, 11, 12];
    expect(ta.roc(p, { period: 1 }).at(-1)!).toBeCloseTo((12 / 11 - 1) * 100, 12);
    expect(ta.rocp(p, { period: 1 }).at(-1)!).toBeCloseTo((12 - 11) / 11, 12);
    expect(ta.rocr(p, { period: 1 }).at(-1)!).toBeCloseTo(12 / 11, 12);
    expect(ta.rocr100(p, { period: 1 }).at(-1)!).toBeCloseTo((12 / 11) * 100, 12);
    expect(ta.momentum(p, { period: 1 }).at(-1)!).toBeCloseTo(1, 12);
  });
  it('momentum warms up at `period`', () => {
    expect(ta.momentum.explain(closes, { period: 10 }).diagnostics.warmup).toBe(10);
  });
});

describe('bounded oscillators stay in range', () => {
  it('Williams %R ∈ [-100, 0]', () => {
    for (const v of ta.williamsR(bars, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(-100);
        expect(v).toBeLessThanOrEqual(0);
      }
    }
  });
  const EPS = 1e-9;
  it('CMO ∈ [-100, 100]; +100 for a strict uptrend', () => {
    for (const v of ta.cmo(closes, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(-100 - EPS);
        expect(v).toBeLessThanOrEqual(100 + EPS);
      }
    }
    expect(ta.cmo([1, 2, 3, 4, 5, 6], { period: 3 }).at(-1)!).toBeCloseTo(100, 12);
    expect(ta.cmo([6, 5, 4, 3, 2, 1], { period: 3 }).at(-1)!).toBeCloseTo(-100, 12);
  });
  it('StochRSI %K and %D ∈ [0, 100]', () => {
    for (const p of ta.stochRsi(closes, {})) {
      if (!Number.isNaN(p.k)) {
        expect(p.k).toBeGreaterThanOrEqual(-EPS);
        expect(p.k).toBeLessThanOrEqual(100 + EPS);
        expect(p.d).toBeGreaterThanOrEqual(-EPS);
        expect(p.d).toBeLessThanOrEqual(100 + EPS);
      }
    }
  });
  it('Ultimate Oscillator ∈ [0, 100]', () => {
    for (const v of ta.ultimateOscillator(bars, {})) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
  it('Connors RSI ∈ [0, 100]', () => {
    for (const v of ta.connorsRsi(closes, { rankPeriod: 20 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('structural relationships', () => {
  it('PPO histogram = ppo − signal; APO is the EMA spread', () => {
    const p = ta.ppo.explain(closes, {});
    const last = p.value.at(-1)!;
    expect(last.histogram).toBeCloseTo(last.ppo - last.signal, 10);
    const apo = ta.apo(closes, { fast: 12, slow: 26 });
    const f = ta.ema(closes, { period: 12 });
    const s = ta.ema(closes, { period: 26 });
    const i = closes.length - 1;
    expect(apo[i]!).toBeCloseTo(f[i]! - s[i]!, 10);
  });
  it('TSI and KST expose a signal alongside the line', () => {
    const t = ta.tsi.explain(closes, {}).value.at(-1)!;
    expect(Number.isFinite(t.tsi)).toBe(true);
    expect(Number.isFinite(t.signal)).toBe(true);
    const k = ta.kst.explain(closes, {}).value.at(-1)!;
    expect(Number.isFinite(k.kst)).toBe(true);
    expect(Number.isFinite(k.signal)).toBe(true);
  });
  it('KST is 0 on a flat series (all four ROCs zero — guards the no-starvation fix)', () => {
    const flat = Array.from({ length: 80 }, () => 100);
    const k = ta.kst.explain(flat, {}).value;
    const last = k.at(-1)!;
    expect(last.kst).toBeCloseTo(0, 9);
    expect(last.signal).toBeCloseTo(0, 9);
    // warmup is gated by the longest ROC+SMA chain, not a starvation cascade
    const warm = ta.kst.explain(flat, {}).diagnostics.warmup;
    expect(warm).toBeLessThan(60); // ROC(30)+SMA(15)+signal(9) ≈ 30+15+9 ≈ 54, not 100+
  });
  it('KST requires exactly four ROC and smoothing periods at every public boundary', () => {
    expect(() => ta.kst.stream({ rocPeriods: [10, 15, 20] as never })).toThrowError(/exactly four/);
    expect(() => ta.kst(closes, { smaPeriods: [10, 10, 10, 15, 20] as never })).toThrowError(
      /exactly four/,
    );
    const snapshot = ta.kst.stream({}).toJSON() as unknown as {
      state: { rocs: unknown[] };
    };
    snapshot.state.rocs.pop();
    expect(() => KstStream.fromJSON(snapshot as never)).toThrowError(/exactly (?:four|4)/);

    // A normal inferred `number[]` remains source-compatible with the public class constructor.
    const periods: number[] = [10, 15, 20, 30];
    expect(
      () => new KstStream({ rocPeriods: periods, smaPeriods: periods, signal: 9 }),
    ).not.toThrow();

    const oversized = Array.from({ length: 5 }, () => 10);
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error('period element was touched before the exact-length check');
      },
    });
    expect(
      () => new KstStream({ rocPeriods: oversized, smaPeriods: periods, signal: 9 }),
    ).toThrowError(/exactly four/);
  });
  it('KST snapshot preflight preserves canonical envelope diagnostics', () => {
    const malformedSnapshot = () => {
      const snapshot = ta.kst.stream({}).toJSON();
      snapshot.state['rocs'] = [];
      return snapshot;
    };

    const unsupported = malformedSnapshot();
    unsupported.schemaVersion = 999;
    let caught: unknown;
    try {
      KstStream.fromJSON(unsupported);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'snapshot.unsupported_version')).toBe(true);

    caught = undefined;
    const unknownKey = Object.assign(malformedSnapshot(), { extraEnvelopeField: true });
    try {
      KstStream.fromJSON(unknownKey);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, ErrorCode.InputUnknownField)).toBe(true);
  });
  it('Awesome Oscillator is SMA5 − SMA34 of the median price', () => {
    const med = bars.map((b) => (b.high + b.low) / 2);
    const ao = ta.awesomeOscillator(bars, {});
    const f = ta.sma(med, { period: 5 });
    const s = ta.sma(med, { period: 34 });
    const i = bars.length - 1;
    expect(ao[i]!).toBeCloseTo(f[i]! - s[i]!, 10);
  });
  it('MACDEXT with EMA types equals the base MACD', () => {
    const ext = ta.macdExt.explain(closes, { fast: 12, slow: 26, signal: 9 });
    const base = ta.macd.explain(closes, { fast: 12, slow: 26, signal: 9 });
    const i = closes.length - 1;
    expect(ext.value[i]!.macd).toBeCloseTo(base.value[i]!.macd, 10);
    expect(ext.value[i]!.signal).toBeCloseTo(base.value[i]!.signal, 10);
  });
  it('CCI is mean-reverting around zero and Fisher exposes a trigger', () => {
    const c = ta.cci(bars, { period: 20 }).filter((v) => !Number.isNaN(v));
    expect(Math.min(...c)).toBeLessThan(0);
    expect(Math.max(...c)).toBeGreaterThan(0);
    const fish = ta.fisherTransform.explain(bars, {}).value.at(-1)!;
    expect(Number.isFinite(fish.fisher)).toBe(true);
    expect(Number.isFinite(fish.trigger)).toBe(true);
  });
});

describe('oscillator streaming parity', () => {
  const scalar = ['roc', 'rocp', 'momentum', 'cmo', 'apo', 'trix', 'dpo', 'connorsRsi'] as const;
  it('scalar oscillators match their streams', () => {
    for (const name of scalar) {
      const parameters =
        name === 'connorsRsi'
          ? { rankPeriod: 20 }
          : name === 'apo'
            ? { fast: 6, slow: 12 }
            : { period: 12 };
      const batch = ta[name].explain(closes, parameters as never);
      const stream = ta[name].stream(parameters as never);
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e).toBeNull();
        else expect(e!).toBeCloseTo(batch.value[i]!, 9);
      }
    }
  });
  it('record oscillators (ppo / stochRsi / tsi / fisher) match their streams', () => {
    const ppoB = ta.ppo.explain(closes, {});
    const ppoS = ta.ppo.stream({});
    for (let i = 0; i < closes.length; i++) {
      const e = ppoS.next(closes[i]!);
      if (i < ppoB.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(ppoB.value[i]);
    }
    const fB = ta.fisherTransform.explain(bars, {});
    const fS = ta.fisherTransform.stream({});
    for (let i = 0; i < bars.length; i++) {
      const e = fS.next(bars[i]!);
      if (i < fB.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(fB.value[i]);
    }
  });
  it('snapshot round-trips a composed oscillator (TSI)', () => {
    const ref = ta.tsi.stream({});
    const expected = closes.map((c) => ref.next(c));
    const part = ta.tsi.stream({});
    for (let i = 0; i < 80; i++) part.next(closes[i]!);
    const restored = ta.tsi.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 80; i < closes.length; i++) {
      const got = restored.next(closes[i]!);
      if (expected[i] === null) expect(got).toBeNull();
      else expect(got).toEqual(expected[i]);
    }
  });
});
