import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

// a clean uptrend, then a clean downtrend, so directional indicators have something to bite on
const up: BarInput[] = Array.from({ length: 50 }, (_, i) => ({
  open: 100 + i,
  high: 100 + i + 1,
  low: 100 + i - 0.5,
  close: 100 + i + 0.5,
  volume: 100,
}));
const down: BarInput[] = Array.from({ length: 50 }, (_, i) => ({
  open: 150 - i,
  high: 150 - i + 0.5,
  low: 150 - i - 1,
  close: 150 - i - 0.5,
  volume: 100,
}));
const bars = [...up, ...down];

describe('DMI / ADXR', () => {
  it('+DI dominates −DI in an uptrend, and DX/ADXR are bounded', () => {
    const d = ta.dmi(up, { period: 14 }).at(-1)!;
    expect(d.plusDI).toBeGreaterThan(d.minusDI);
    expect(d.dx).toBeGreaterThanOrEqual(0);
    expect(d.dx).toBeLessThanOrEqual(100);
    for (const v of ta.adxr(bars, { period: 14 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
  it('plusDI/minusDI projections equal the dmi record fields', () => {
    const rec = ta.dmi(bars, { period: 14 });
    const p = ta.plusDI(bars, { period: 14 });
    const m = ta.minusDI(bars, { period: 14 });
    for (let i = 0; i < bars.length; i++) {
      if (!Number.isNaN(p[i]!)) {
        expect(p[i]!).toBeCloseTo(rec[i]!.plusDI, 10);
        expect(m[i]!).toBeCloseTo(rec[i]!.minusDI, 10);
      }
    }
  });
});

describe('Aroon', () => {
  it('Aroon Up ≈ 100 in a fresh uptrend; oscillator = up − down', () => {
    const a = ta.aroon(up, { period: 14 }).at(-1)!;
    expect(a.up).toBeCloseTo(100, 6);
    expect(a.down).toBeLessThan(a.up);
    const osc = ta.aroonOscillator(up, { period: 14 }).at(-1)!;
    expect(osc).toBeCloseTo(a.up - a.down, 10);
  });
});

describe('Parabolic SAR', () => {
  it('sits below price in an uptrend and flips on the reversal', () => {
    const r = ta.psar(bars, {});
    // during the uptrend section SAR should be below the close
    expect(r[40]!.sar).toBeLessThan(bars[40]!.close);
    expect(r[40]!.trend).toBe(1);
    // after the reversal into the downtrend, trend turns negative somewhere
    expect(r.slice(60).some((p) => p.trend === -1)).toBe(true);
  });
});

describe('Supertrend', () => {
  it('direction is +1 in the uptrend and the line tracks below price', () => {
    const r = ta.supertrend(up, { period: 10, multiplier: 3 });
    const last = r.at(-1)!;
    expect(last.direction).toBe(1);
    expect(last.supertrend).toBeLessThan(up.at(-1)!.close);
    // flips to −1 at some point through the full up→down series
    const full = ta.supertrend(bars, { period: 10, multiplier: 3 });
    expect(full.some((p) => p.direction === -1)).toBe(true);
  });
});

describe('Ichimoku & Vortex', () => {
  it('Ichimoku senkouA is the mean of tenkan and kijun', () => {
    const r = ta.ichimoku(bars, {}).at(-1)!;
    expect(r.senkouA).toBeCloseTo((r.tenkan + r.kijun) / 2, 10);
    expect(r.chikou).toBe(bars.at(-1)!.close);
  });
  it('Vortex VI+ exceeds VI− in an uptrend and both are positive', () => {
    const r = ta.vortex(up, { period: 14 }).at(-1)!;
    expect(r.viPlus).toBeGreaterThan(r.viMinus);
    expect(r.viPlus).toBeGreaterThan(0);
  });
});

describe('Linear regression / TSF', () => {
  it('recovers the slope and intercept of a perfect line', () => {
    const line = Array.from({ length: 20 }, (_, i) => 3 + 2 * i);
    const r = ta.linreg.explain(line, { period: 10 }).value.at(-1)!;
    expect(r.slope).toBeCloseTo(2, 9);
    // regression value at the window endpoint equals the actual price on a perfect line
    expect(r.value).toBeCloseTo(line.at(-1)!, 7);
    // forecast is the next point
    expect(r.forecast).toBeCloseTo(line.at(-1)! + 2, 7);
    expect(ta.tsf(line, { period: 10 }).at(-1)!).toBeCloseTo(line.at(-1)! + 2, 7);
    expect(ta.linregSlope(line, { period: 10 }).at(-1)!).toBeCloseTo(2, 9);
  });
});

describe('Chandelier exits & ZigZag', () => {
  it('long exit is below the recent high; short exit above the recent low', () => {
    const r = ta.chandelierExit(up, { period: 14, multiplier: 3 }).at(-1)!;
    const hh = Math.max(...up.slice(-14).map((b) => b.high));
    const ll = Math.min(...up.slice(-14).map((b) => b.low));
    expect(r.long).toBeLessThan(hh);
    expect(r.short).toBeGreaterThan(ll);
  });
  it('ZigZag finds alternating pivots that reverse by at least the deviation', () => {
    const { pivots } = ta.zigzag(bars, { deviation: 5 });
    expect(pivots.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i]!.kind).not.toBe(pivots[i - 1]!.kind); // strictly alternating
    }
    // captures the major high around the up→down transition
    expect(pivots.some((p) => p.kind === 'high' && p.price > 148)).toBe(true);
  });
  it('ZigZag validates its required deviation and every bar', () => {
    expect(() => ta.zigzag([], {} as never)).toThrow(/deviation is required/);
    expect(() => ta.zigzag([], { deviation: Number.NaN })).toThrow(InputError);
    expect(() =>
      ta.zigzag(
        [
          { high: 2, low: 1, close: 1.5 },
          { high: 3, low: 2, close: Number.NaN },
        ],
        { deviation: 5 },
      ),
    ).toThrow(/bars\[1\]\.close/);
  });
});

describe('directional movement, extended SAR, Donchian trend', () => {
  it('+DM/−DM equal the dmi record fields and +DM dominates in an uptrend', () => {
    const rec = ta.dmi(up, { period: 14 });
    const p = ta.plusDM(up, { period: 14 });
    const m = ta.minusDM(up, { period: 14 });
    const i = up.length - 1;
    expect(p[i]!).toBeCloseTo(rec[i]!.plusDM, 10);
    expect(m[i]!).toBeCloseTo(rec[i]!.minusDM, 10);
    expect(p[i]!).toBeGreaterThan(m[i]!);
  });
  it('Extended SAR is signed: positive in the uptrend, negative after the reversal', () => {
    const r = ta.psarExt(bars, {});
    expect(r[40]!).toBeGreaterThan(0); // long leg
    expect(r.slice(60).some((v) => v < 0)).toBe(true); // flips short in the downtrend
  });
  it('Donchian trend turns +1 on a new-high breakout, −1 on a new-low breakdown', () => {
    const full = ta.donchianTrend(bars, { period: 10 });
    expect(full[40]).toBe(1);
    expect(full.slice(60).some((v) => v === -1)).toBe(true);
  });
});

describe('trend streaming parity', () => {
  it('record trend indicators match their streams', () => {
    for (const [name, parameters] of [
      ['dmi', { period: 14 }],
      ['aroon', { period: 14 }],
      ['psar', {}],
      ['supertrend', { period: 10 }],
      ['ichimoku', {}],
      ['vortex', { period: 14 }],
      ['chandelierExit', { period: 14 }],
    ] as const) {
      const batch = ta[name].explain(bars, parameters as never);
      const stream = ta[name].stream(parameters as never);
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips Supertrend (composed with ATR)', () => {
    const ref = ta.supertrend.stream({ period: 10, multiplier: 3 });
    const expected = bars.map((b) => ref.next(b));
    const part = ta.supertrend.stream({ period: 10, multiplier: 3 });
    for (let i = 0; i < 60; i++) part.next(bars[i]!);
    const restored = ta.supertrend.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 60; i < bars.length; i++) {
      const got = restored.next(bars[i]!);
      if (expected[i] === null) expect(got).toBeNull();
      else expect(got).toEqual(expected[i]);
    }
  });
});
