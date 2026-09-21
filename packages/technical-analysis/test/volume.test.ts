import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 6 + i * 0.08);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 1000 + (i % 11) * 120,
}));

describe('A/D, Chaikin Oscillator & Money Flow', () => {
  it('A/D adds the money-flow-multiplier × volume each bar', () => {
    const b: BarInput = { high: 10, low: 8, close: 9.5, volume: 1000 };
    const mfm = (9.5 - 8 - (10 - 9.5)) / (10 - 8);
    expect(ta.adLine([b], {})[0]!).toBeCloseTo(mfm * 1000, 9);
  });
  it('Chaikin Oscillator is EMA3(AD) − EMA10(AD)', () => {
    const ad = ta.adLine(bars, {});
    const f = ta.ema(ad, { period: 3 });
    const s = ta.ema(ad, { period: 10 });
    const osc = ta.chaikinOscillator(bars, {});
    const i = bars.length - 1;
    expect(osc[i]!).toBeCloseTo(f[i]! - s[i]!, 7);
  });
  it('CMF ∈ [-1, 1]', () => {
    for (const v of ta.chaikinMoneyFlow(bars, { period: 20 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('MFI', () => {
  it('stays within [0, 100] and is 100 on a strict rising series', () => {
    for (const v of ta.mfi(bars, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    const rising: BarInput[] = Array.from({ length: 10 }, (_, i) => ({
      high: 10 + i + 0.5,
      low: 10 + i - 0.5,
      close: 10 + i,
      volume: 1000,
    }));
    expect(ta.mfi(rising, { period: 3 }).at(-1)!).toBeCloseTo(100, 9);
  });
});

describe('cumulative volume indicators', () => {
  it('PVT and CVD accumulate signed volume', () => {
    const pvt = ta.pvt(bars, {});
    expect(pvt[0]).toBe(0);
    expect(Number.isFinite(pvt.at(-1)!)).toBe(true);
    // CVD: bar0 = 0, bar1 up → +volume1
    const cvd = ta.cvd(bars, {});
    expect(cvd[0]).toBe(0);
    expect(cvd[1]).toBeCloseTo(bars[1]!.volume! * Math.sign(bars[1]!.close - bars[0]!.close), 9);
  });
  it('NVI and PVI start at 1000', () => {
    expect(ta.nvi(bars, {})[0]).toBe(1000);
    expect(ta.pvi(bars, {})[0]).toBe(1000);
  });
  it('relative volume is current volume over its rolling average', () => {
    const rv = ta.relativeVolume(bars, { period: 10 });
    const avg = ta.sma(
      bars.map((b) => b.volume!),
      { period: 10 },
    );
    const i = bars.length - 1;
    expect(rv[i]!).toBeCloseTo(bars[i]!.volume! / avg[i]!, 9);
  });
});

describe('Force Index, EoM, Klinger, VFI', () => {
  it('Force Index, EoM and VFI produce finite values after warmup', () => {
    for (const [name, parameters] of [
      ['forceIndex', { period: 13 }],
      ['easeOfMovement', { period: 14 }],
      ['vfi', { period: 20 }],
    ] as const) {
      const out = ta[name].explain(bars, parameters as never);
      expect(Number.isFinite(out.value[out.diagnostics.warmup] as number), name).toBe(true);
    }
  });
  it('Klinger exposes oscillator and signal', () => {
    const k = ta.klinger.explain(bars, { fast: 13, slow: 21, signal: 8 }).value.at(-1)!;
    expect(Number.isFinite(k.klinger)).toBe(true);
    expect(Number.isFinite(k.signal)).toBe(true);
  });
});

describe('volume profile & order-book imbalance', () => {
  it('volume profile distributes total volume and finds a POC inside the range', () => {
    const vp = ta.volumeProfile(bars, { bins: 20 });
    const totalVolume = bars.reduce((s, b) => s + b.volume!, 0);
    expect(vp.totalVolume).toBeCloseTo(totalVolume, 6);
    const lo = Math.min(...bars.map((b) => b.low));
    const hi = Math.max(...bars.map((b) => b.high));
    expect(vp.poc!).toBeGreaterThanOrEqual(lo);
    expect(vp.poc!).toBeLessThanOrEqual(hi);
    expect(vp.valueArea.low!).toBeLessThanOrEqual(vp.poc!);
    expect(vp.valueArea.high!).toBeGreaterThanOrEqual(vp.poc!);
  });
  it('order-book imbalance maps to [-1, 1]; zero-depth is null with a warning', () => {
    expect(ta.orderBookImbalance({ bidSize: 100, askSize: 0 })).toBe(1);
    expect(ta.orderBookImbalance({ bidSize: 0, askSize: 100 })).toBe(-1);
    expect(ta.orderBookImbalance({ bidSize: 50, askSize: 50 })).toBe(0);
    const empty = ta.orderBookImbalance.explain({ bidSize: 0, askSize: 0 });
    expect(empty.value).toBeNull();
    expect(empty.diagnostics.warnings[0]!.code).toBe('input.degenerate');
    expect(() => ta.orderBookImbalance({ bidSize: -2, askSize: 1 })).toThrow(InputError);
  });
});

describe('volume streaming parity & snapshots', () => {
  it('volume indicators match their streams', () => {
    const names = [
      'adLine',
      'chaikinOscillator',
      'chaikinMoneyFlow',
      'mfi',
      'pvt',
      'forceIndex',
      'nvi',
      'pvi',
      'relativeVolume',
      'cvd',
      'vfi',
    ] as const;
    for (const name of names) {
      // Per-indicator declared parameters (Law 12 rejects the old blanket `{ period }`).
      const PARAMS: Record<string, object> = {
        chaikinOscillator: { fast: 3, slow: 10 },
        chaikinMoneyFlow: { period: 14 },
        mfi: { period: 14 },
        forceIndex: { period: 13 },
        relativeVolume: { period: 14 },
        vfi: { period: 20 },
      };
      const parameters = PARAMS[name] ?? {};
      const batch = ta[name].explain(bars, parameters as never);
      const stream = ta[name].stream(parameters as never);
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 7);
      }
    }
  });
  it('snapshot round-trips Klinger (composed EMAs) and CMF', () => {
    for (const [name, parameters] of [
      ['klinger', { fast: 13, slow: 21, signal: 8 }],
      ['chaikinMoneyFlow', { period: 20 }],
    ] as const) {
      const ref = ta[name].stream(parameters as never);
      const expected = bars.map((b) => ref.next(b));
      const part = ta[name].stream(parameters as never);
      for (let i = 0; i < 50; i++) part.next(bars[i]!);
      const restored = ta[name].fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 50; i < bars.length; i++) {
        const got = restored.next(bars[i]!);
        if (expected[i] === null) expect(got, name).toBeNull();
        else expect(got, name).toEqual(expected[i]);
      }
    }
  });
});
