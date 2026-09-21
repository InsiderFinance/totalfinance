import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.4,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 1000 + (i % 7) * 100,
}));

describe('series momentum (closed-form checks)', () => {
  it('bias is the % distance from the SMA (0 on a flat series)', () => {
    const flat = Array.from({ length: 40 }, () => 50);
    expect(ta.bias(flat, { period: 26 }).at(-1)!).toBeCloseTo(0, 9);
    const b = ta.bias(closes, { period: 20 });
    const sma = ta.sma(closes, { period: 20 });
    const i = closes.length - 1;
    expect(b[i]!).toBeCloseTo(((closes[i]! - sma[i]!) / sma[i]!) * 100, 9);
  });
  it('CFO ≈ 0 on a perfect line; forecast oscillator is negative on a rising line', () => {
    const line = Array.from({ length: 30 }, (_, i) => 10 + 2 * i);
    expect(ta.cfo(line, { period: 10 }).at(-1)!).toBeCloseTo(0, 6);
    // forecast = next point (above current) → (price − forecast)/price < 0 on a rising line
    expect(ta.forecastOscillator(line, { period: 10 }).at(-1)!).toBeLessThan(0);
  });
  it('CTI is +1 on a rising line and −1 on a falling line', () => {
    const up = Array.from({ length: 20 }, (_, i) => i);
    const down = Array.from({ length: 20 }, (_, i) => -i);
    expect(ta.cti(up, { period: 12 }).at(-1)!).toBeCloseTo(1, 9);
    expect(ta.cti(down, { period: 12 }).at(-1)!).toBeCloseTo(-1, 9);
  });
  it('efficiency ratio is 1 on a monotonic ramp and ∈ [0, 1]', () => {
    const ramp = Array.from({ length: 30 }, (_, i) => i);
    expect(ta.efficiencyRatio(ramp, { period: 10 }).at(-1)!).toBeCloseTo(1, 12);
    for (const v of ta.efficiencyRatio(closes, { period: 10 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
  it('slope is rise/run', () => {
    const line = Array.from({ length: 20 }, (_, i) => 3 + 2 * i);
    expect(ta.slope(line, { period: 1 }).at(-1)!).toBeCloseTo(2, 12);
    expect(ta.slope(line, { period: 5 }).at(-1)!).toBeCloseTo(2, 12);
  });
  it('psychological line ∈ [0, 100]; 100 on a strictly rising series', () => {
    const rising = Array.from({ length: 20 }, (_, i) => i);
    expect(ta.psychologicalLine(rising, { period: 12 }).at(-1)!).toBe(100);
    for (const v of ta.psychologicalLine(closes, { period: 12 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
  it('center of gravity & Coppock produce finite values after warmup', () => {
    expect(Number.isFinite(ta.centerOfGravity(closes, { period: 10 }).at(-1)!)).toBe(true);
    expect(Number.isFinite(ta.coppock(closes, {}).at(-1)!)).toBe(true);
  });
});

describe('record momentum', () => {
  it('PVO / TRIX histogram / SMI ergodic expose consistent histogram/oscillator', () => {
    const p = ta.pvo.explain(bars, {}).value.at(-1)!;
    expect(p.histogram).toBeCloseTo(p.pvo - p.signal, 9);
    const t = ta.trixHistogram.explain(closes, {}).value.at(-1)!;
    expect(t.histogram).toBeCloseTo(t.trix - t.signal, 9);
    const s = ta.smiErgodic.explain(closes, {}).value.at(-1)!;
    expect(s.oscillator).toBeCloseTo(s.smi - s.signal, 9);
  });
  it('Elder Ray bull ≥ bear; KDJ J = 3K − 2D', () => {
    const er = ta.elderRay.explain(bars, {}).value.at(-1)!;
    expect(er.bull).toBeGreaterThanOrEqual(er.bear);
    const k = ta.kdj.explain(bars, {}).value.at(-1)!;
    expect(k.j).toBeCloseTo(3 * k.k - 2 * k.d, 9);
    expect(k.k).toBeGreaterThanOrEqual(0);
    expect(k.k).toBeLessThanOrEqual(100);
  });
  it('BRAR / RVGI / volume-weighted MACD are finite', () => {
    const br = ta.brar.explain(bars, {}).value.at(-1)!;
    expect(Number.isFinite(br.popularityIndex)).toBe(true);
    expect(Number.isFinite(br.willingnessIndex)).toBe(true);
    const r = ta.relativeVigorIndex.explain(bars, {}).value.at(-1)!;
    expect(Number.isFinite(r.rvi)).toBe(true);
    const vw = ta.volumeWeightedMacd.explain(bars, {}).value.at(-1)!;
    expect(vw.histogram).toBeCloseTo(vw.macd - vw.signal, 9);
    expect(Number.isFinite(ta.pgo(bars, {}).at(-1)!)).toBe(true);
  });
});

describe('momentum-ext streaming parity & snapshots', () => {
  it('series indicators match their streams', () => {
    const names = [
      'bias',
      'cfo',
      'forecastOscillator',
      'coppock',
      'cti',
      'efficiencyRatio',
      'centerOfGravity',
      'psychologicalLine',
      'slope',
    ] as const;
    for (const name of names) {
      const ind = ta[name] as Indicator<{ period?: number }, number, number>;
      const batch = ind.explain(closes, {});
      const stream = ind.stream({});
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
  });
  it('record / bar indicators match their streams', () => {
    for (const name of [
      'pvo',
      'elderRay',
      'brar',
      'kdj',
      'relativeVigorIndex',
      'volumeWeightedMacd',
    ] as const) {
      const batch = ta[name].explain(bars, {});
      const stream = ta[name].stream({});
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips a composed indicator (coppock) and a bar one (kdj)', () => {
    const refC = ta.coppock.stream({});
    const expectedC = closes.map((c) => refC.next(c));
    const partC = ta.coppock.stream({});
    for (let i = 0; i < 60; i++) partC.next(closes[i]!);
    const restoredC = ta.coppock.fromJSON(JSON.parse(JSON.stringify(partC.toJSON())));
    for (let i = 60; i < closes.length; i++) {
      const got = restoredC.next(closes[i]!);
      if (expectedC[i] === null) expect(got).toBeNull();
      else expect(got as number).toBeCloseTo(expectedC[i] as number, 9);
    }
    const refK = ta.kdj.stream({});
    const expectedK = bars.map((b) => refK.next(b));
    const partK = ta.kdj.stream({});
    for (let i = 0; i < 30; i++) partK.next(bars[i]!);
    const restoredK = ta.kdj.fromJSON(JSON.parse(JSON.stringify(partK.toJSON())));
    for (let i = 30; i < bars.length; i++) {
      const got = restoredK.next(bars[i]!);
      if (expectedK[i] === null) expect(got).toBeNull();
      else expect(got).toEqual(expectedK[i]);
    }
  });
});
