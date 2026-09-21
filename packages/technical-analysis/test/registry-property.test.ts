import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { listIndicators } from '@totalfinance/technical-analysis/registry';
import { indicatorWarmups } from '@totalfinance/technical-analysis/warmup';
import { pairs } from '@totalfinance/technical-analysis/statistics';
import type { BarInput, Indicator } from '@totalfinance/technical-analysis';

/**
 * Registry-wide property tests — universal invariants asserted across EVERY registered indicator,
 * not a hand-picked few:
 *   • batch ≡ stream (the framework's core guarantee, proven for all 303 indicators)
 *   • serializable streaming state survives a JSON round-trip mid-stream
 *   • degenerate inputs (flat prices, zero volume, monotonic) never raise a *raw* error — only the
 *     typed `InputError` is allowed (TotalFinance design law #4)
 *   • bounded oscillators stay in range; bad parameters throw `InputError`
 */

type AnyInd = Indicator<Record<string, unknown>, unknown, unknown>;
const indicators = listIndicators();
const paramsByName = new Map(indicatorWarmups(280).map((w) => [w.name, w.parameters]));

function dataset(kind: 'normal' | 'flat' | 'zeroVolume' | 'monotonic', n: number) {
  const series: number[] = [];
  for (let i = 0; i < n; i++) {
    if (kind === 'flat') series.push(100);
    else if (kind === 'monotonic') series.push(100 + i);
    else series.push(100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1));
  }
  const bars: BarInput[] = series.map((c, i) => {
    const open = i === 0 ? c : series[i - 1]!;
    return {
      open: kind === 'flat' ? c : open,
      high: kind === 'flat' ? c : Math.max(open, c) + 1 + (i % 3) * 0.5,
      low: kind === 'flat' ? c : Math.min(open, c) - 1 - (i % 4) * 0.3,
      close: c,
      volume: kind === 'zeroVolume' ? 0 : kind === 'flat' ? 1000 : 1000 + ((i * 53) % 400),
    };
  });
  const other = series.map((v, i) => (kind === 'flat' ? 100 : v + Math.cos(i / 4) * 3));
  return { series, bars, pair: pairs(series, other) };
}

const inputFor = (e: { inputs: string }, d: ReturnType<typeof dataset>): readonly unknown[] =>
  e.inputs === 'series' ? d.series : e.inputs === 'bars' ? d.bars : d.pair;

/** Deep equality that treats NaN === NaN (record outputs carry NaN sentinels in warmup). */
function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

describe('property: batch ≡ stream for every indicator', () => {
  const d = dataset('normal', 260);
  for (const e of indicators) {
    it(`${e.name}`, () => {
      const ind = e.indicator as AnyInd;
      const parameters = paramsByName.get(e.name)!;
      const input = inputFor(e, d);
      const {
        value,
        diagnostics: { warmup },
      } = ind.explain(input, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < input.length; i++) {
        const out = stream.next(input[i]);
        if (i < warmup) expect(out, `${e.name}[${i}] should be warmup-null`).toBeNull();
        else expect(eq(out, value[i]), `${e.name}[${i}] stream≠batch`).toBe(true);
      }
      // the live `.value` getter mirrors the last `next`
      expect(eq(stream.value, value[input.length - 1])).toBe(true);
    });
  }
});

describe('property: streaming state survives a JSON round-trip', () => {
  const d = dataset('normal', 240);
  for (const e of indicators) {
    it(`${e.name}`, () => {
      const ind = e.indicator as AnyInd;
      const parameters = paramsByName.get(e.name)!;
      const input = inputFor(e, d);
      const {
        value,
        diagnostics: { warmup },
      } = ind.explain(input, parameters);
      const cut = Math.min(warmup + 8, input.length - 4);
      const partial = ind.stream(parameters);
      for (let i = 0; i <= cut; i++) partial.next(input[i]);
      const restored = ind.fromJSON(JSON.parse(JSON.stringify(partial.toJSON())));
      for (let i = cut + 1; i < input.length; i++) {
        expect(eq(restored.next(input[i]), value[i]), `${e.name}[${i}] post-restore`).toBe(true);
      }
    });
  }
});

describe('property: degenerate inputs never raise a raw error', () => {
  for (const kind of ['flat', 'zeroVolume', 'monotonic'] as const) {
    const d = dataset(kind, 120);
    it(`${kind} prices — every indicator returns an aligned series or throws InputError`, () => {
      const bad: string[] = [];
      for (const e of indicators) {
        const ind = e.indicator as AnyInd;
        const parameters = paramsByName.get(e.name)!;
        const input = inputFor(e, d);
        try {
          const out = ind(input, parameters);
          if (out.length !== input.length)
            bad.push(`${e.name}: length ${out.length}≠${input.length}`);
        } catch (err) {
          if (!(err instanceof InputError))
            bad.push(`${e.name}: raw ${(err as Error)?.constructor?.name}`);
        }
      }
      expect(bad, `failures on ${kind}: ${bad.join(' | ')}`).toEqual([]);
    });
  }
});

describe('bounded oscillators stay within range', () => {
  const d = dataset('normal', 200);
  const bounds: [string, 'series' | 'bars', number, number][] = [
    ['rsi', 'series', 0, 100],
    ['mfi', 'bars', 0, 100],
    ['williamsR', 'bars', -100, 0],
    ['cmo', 'series', -100, 100],
    ['aroonOscillator', 'bars', -100, 100],
    ['bop', 'bars', -1, 1],
    ['chaikinMoneyFlow', 'bars', -1, 1],
    ['choppinessIndex', 'bars', 0, 100],
  ];
  for (const [name, kind, lo, hi] of bounds) {
    it(`${name} ∈ [${lo}, ${hi}]`, () => {
      const e = indicators.find((x) => x.name === name)!;
      const out = (e.indicator as AnyInd)(
        kind === 'series' ? d.series : d.bars,
        paramsByName.get(name)!,
      );
      for (const v of out) {
        if (v == null || Number.isNaN(v as number)) continue;
        expect(v as number).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(v as number).toBeLessThanOrEqual(hi + 1e-9);
      }
    });
  }
});

describe('bad parameters throw typed InputError', () => {
  const d = dataset('normal', 60);
  // a representative period-driven indicator from each input class
  const cases: [string, 'series' | 'bars', Record<string, unknown>][] = [
    ['sma', 'series', { period: 0 }],
    ['ema', 'series', { period: -5 }],
    ['rsi', 'series', { period: NaN }],
    ['atr', 'bars', { period: 0 }],
    ['bbands', 'series', { period: -1 }],
  ];
  for (const [name, kind, parameters] of cases) {
    it(`${name} ${JSON.stringify(parameters)} → InputError`, () => {
      const e = indicators.find((x) => x.name === name)!;
      expect(() =>
        (e.indicator as AnyInd)(kind === 'series' ? d.series : d.bars, parameters),
      ).toThrow(InputError);
    });
  }
});
