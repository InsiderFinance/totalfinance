import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { listIndicators } from '@totalfinance/technical-analysis/registry';
import { indicatorWarmups } from '@totalfinance/technical-analysis/warmup';
import { pairs } from '@totalfinance/technical-analysis/statistics';
import type { BarInput, Indicator } from '@totalfinance/technical-analysis';

/**
 * Degenerate-OHLC robustness matrix — runs EVERY registered indicator through a battery of realistic
 * market pathologies (gaps, halts, splits, limit-locked sessions, inverted/zero/negative bars,
 * single spikes, and 1–2 bar inputs) and asserts the universal robustness contract under each:
 *   • no *raw* throw — only the typed `InputError` is allowed (design law #4);
 *   • output is aligned to the input length;
 *   • **no value is ±Infinity** (null for warmup and NaN-sentinels for genuinely-undefined results
 *     are allowed, but a leaked Infinity is a bug);
 *   • batch ≡ stream still holds under the pathology.
 * This complements registry-property.test.ts (flat/zeroVolume/monotonic) with adversarial real-world
 * data shapes a live feed actually produces.
 */

type AnyInd = Indicator<Record<string, unknown>, unknown, unknown>;
const indicators = listIndicators();
const paramsByName = new Map(indicatorWarmups(200).map((w) => [w.name, w.parameters]));

type Kind =
  | 'gaps'
  | 'halts'
  | 'split'
  | 'limitLock'
  | 'inverted'
  | 'spike'
  | 'zeros'
  | 'negative'
  | 'alternating';

function make(
  kind: Kind,
  n: number,
): { series: number[]; bars: BarInput[]; pair: ReturnType<typeof pairs> } {
  const series: number[] = [];
  for (let i = 0; i < n; i++) {
    let c = 100 + Math.sin(i / 5) * 6 + i * 0.05;
    if (kind === 'gaps' && i % 9 === 0) c *= i % 18 === 0 ? 1.25 : 0.8; // ±20–25% jumps
    if (kind === 'split' && i >= Math.floor(n / 2)) c /= 2; // 2:1 split midway
    if (kind === 'halts') c = 100 + Math.floor(i / 6) * 3; // runs of identical closes
    if (kind === 'limitLock') c = 100 + Math.floor(i / 10); // long flat steps
    if (kind === 'zeros') c = 0;
    if (kind === 'negative') c = -50 - Math.sin(i / 5) * 6;
    if (kind === 'alternating') c = i % 2 === 0 ? 110 : 90;
    series.push(c);
  }
  const bars: BarInput[] = series.map((c, i) => {
    const open = i === 0 ? c : series[i - 1]!;
    let high = Math.max(open, c) + 1;
    let low = Math.min(open, c) - 1;
    let volume = 1000 + ((i * 53) % 400);
    if (kind === 'halts' || kind === 'limitLock') {
      high = c;
      low = c;
      volume = kind === 'halts' ? 0 : 500;
    }
    if (kind === 'inverted') {
      // invalid bar: high below low (corrupt feed) — must not crash or blow up
      high = low - 2;
      low = high + 4;
    }
    if (kind === 'spike' && i === Math.floor(n / 2)) {
      high = c + 500;
      low = c - 500;
      volume = 1_000_000;
    }
    if (kind === 'zeros') {
      high = 0;
      low = 0;
      volume = 0;
    }
    return { open, high, low, close: c, volume };
  });
  const other = series.map((v, i) => v + Math.cos(i / 4) * 2 + 0.5);
  return { series, bars, pair: pairs(series, other) };
}

const inputFor = (kindOf: string, d: ReturnType<typeof make>): readonly unknown[] =>
  kindOf === 'series' ? d.series : kindOf === 'bars' ? d.bars : d.pair;

/** Walk every numeric leaf of an output element; return true if any is ±Infinity. */
function hasInfinity(v: unknown): boolean {
  if (typeof v === 'number') return v === Infinity || v === -Infinity;
  if (v && typeof v === 'object') return Object.values(v as object).some(hasInfinity);
  return false;
}

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

/** A warmup "empty" output: stream emits `null`, the batch facade fills the `nan(parameters)` sentinel
 *  (NaN scalar or an all-NaN object). Treat the two encodings as equivalent. */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return Number.isNaN(v);
  if (typeof v === 'object') {
    const vals = Object.values(v as object);
    return vals.length > 0 && vals.every(isEmpty);
  }
  return false;
}
const softEq = (a: unknown, b: unknown): boolean => (isEmpty(a) && isEmpty(b)) || eq(a, b);

const KINDS: Kind[] = [
  'gaps',
  'halts',
  'split',
  'limitLock',
  'inverted',
  'spike',
  'zeros',
  'negative',
  'alternating',
];

describe('degenerate-OHLC matrix: no raw throw, aligned, no Infinity', () => {
  for (const kind of KINDS) {
    const d = make(kind, 100);
    it(`${kind}: every indicator stays robust`, () => {
      const bad: string[] = [];
      for (const e of indicators) {
        const ind = e.indicator as AnyInd;
        const parameters = paramsByName.get(e.name)!;
        const input = inputFor(e.inputs, d);
        try {
          const out = ind(input, parameters);
          if (out.length !== input.length) {
            bad.push(`${e.name}: length ${out.length}≠${input.length}`);
            continue;
          }
          // math transforms (ln/log10/…) legitimately return ±Infinity for 0/negative inputs (IEEE);
          // every other category must never leak an Infinity.
          if (e.category !== 'math') {
            const infAt = out.findIndex(hasInfinity);
            if (infAt >= 0) bad.push(`${e.name}: Infinity@${infAt}`);
          }
        } catch (err) {
          if (!(err instanceof InputError))
            bad.push(`${e.name}: raw ${(err as Error)?.constructor?.name}`);
        }
      }
      expect(bad, `${kind} failures: ${bad.join(' | ')}`).toEqual([]);
    });
  }
});

describe('degenerate-OHLC matrix: batch ≡ stream under pathologies', () => {
  for (const kind of ['gaps', 'split', 'spike', 'inverted', 'alternating'] as const) {
    const d = make(kind, 90);
    it(`${kind}: streaming reproduces batch`, () => {
      const bad: string[] = [];
      for (const e of indicators) {
        const ind = e.indicator as AnyInd;
        const parameters = paramsByName.get(e.name)!;
        const input = inputFor(e.inputs, d);
        let value: unknown[];
        try {
          value = ind(input, parameters);
        } catch (err) {
          if (!(err instanceof InputError)) bad.push(`${e.name}: batch raw`);
          continue;
        }
        const stream = ind.stream(parameters);
        for (let i = 0; i < input.length; i++) {
          const out = stream.next(input[i]);
          if (!softEq(out, value[i])) {
            bad.push(`${e.name}@${i}`);
            break;
          }
        }
      }
      expect(bad, `${kind} batch≠stream: ${bad.join(' | ')}`).toEqual([]);
    });
  }
});

describe('degenerate-OHLC matrix: tiny inputs (0, 1, 2 bars)', () => {
  for (const length of [0, 1, 2] as const) {
    it(`${length}-bar input: no raw throw, aligned output`, () => {
      const d = make('gaps', Math.max(length, 1));
      const bad: string[] = [];
      for (const e of indicators) {
        const ind = e.indicator as AnyInd;
        const parameters = paramsByName.get(e.name)!;
        const full = inputFor(e.inputs, d);
        const input = full.slice(0, length);
        try {
          const out = ind(input, parameters);
          if (out.length !== length) bad.push(`${e.name}: length ${out.length}≠${length}`);
          if (out.findIndex(hasInfinity) >= 0) bad.push(`${e.name}: Infinity`);
        } catch (err) {
          if (!(err instanceof InputError))
            bad.push(`${e.name}: raw ${(err as Error)?.constructor?.name}`);
        }
      }
      expect(bad, `${length}-bar failures: ${bad.join(' | ')}`).toEqual([]);
    });
  }
});
