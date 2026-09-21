import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ta from '@totalfinance/technical-analysis';
import { pairs } from '@totalfinance/technical-analysis/statistics';
import { TULIPY_ASSERTED } from './golden/proof-manifest';

/**
 * Tertiary parity against **tulipy** (Tulip Indicators) — an independent C reference, separate from
 * TA-Lib. Certifies the Mesa Sine Wave (`msw`, which TA-Lib/pandas-ta lack) and independently
 * confirms the cross utilities and a few overlaps. Expected values come from
 * `tools/golden/generate_tulipy.py`.
 */

interface Entry {
  name: string;
  parameters: Record<string, number | string[]>;
  outputs: Record<string, (number | null)[]>;
}
const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
const golden = load<{ entries: Entry[] }>('tulipy-golden.json');
const D = load<{
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}>('reference-ohlcv.json');
const C = D.close;
const O = D.open;
const bars = C.map((c, i) => ({
  open: O[i]!,
  high: D.high[i]!,
  low: D.low[i]!,
  close: c,
  volume: D.volume[i]!,
}));
type Series = readonly (number | null)[];
const get = (n: string): Entry => golden.entries.find((e) => e.name === n)!;
const col = (a: readonly unknown[], k: string): Series =>
  a.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));

const live = (a: number | null | undefined): a is number => a != null && !Number.isNaN(a);

/** Returns { compared, outliers, firstQk, gaps } for a strict element-wise comparison. `gaps` counts
 *  indices where tulipy has a value but TotalFinance (past its first value) does not. */
function difference(actual: Series, expected: Series, tolerance: number) {
  let compared = 0;
  let outliers = 0;
  let gaps = 0;
  const firstQk = actual.findIndex(live);
  for (let i = 0; i < expected.length; i++) {
    const x = expected[i];
    if (x == null) continue;
    const a = actual[i];
    if (firstQk >= 0 && i >= firstQk && !live(a)) gaps++;
    if (!live(a)) continue;
    compared++;
    if (Math.abs(a - x) > tolerance) outliers++;
  }
  return { compared, outliers, firstQk, gaps };
}

function assertStrict(actual: Series, expected: Series, label: string): void {
  const { compared, outliers, gaps } = difference(actual, expected, 1e-7);
  expect(compared, `${label} compared`).toBeGreaterThan(50);
  expect(outliers, `${label} mismatches`).toBe(0);
  expect(gaps, `${label} coverage gaps (TotalFinance null where tulipy has a value)`).toBe(0);
}

describe('tulipy parity (independent C reference)', () => {
  it('manifest classifies every committed fixture exactly (none invented, none unasserted)', () => {
    const fixtures = golden.entries.map((e) => e.name).sort();
    expect([...TULIPY_ASSERTED].sort()).toEqual(fixtures);
  });

  it('crossover / crossany match tulipy exactly', () => {
    assertStrict(ta.crossover(pairs(C, O), {}), get('crossover').outputs['real']!, 'crossover');
    assertStrict(ta.crossany(pairs(C, O), {}), get('crossany').outputs['real']!, 'crossany');
  });

  it('qstick / williamsAd / marketFacilitationIndex match tulipy exactly', () => {
    assertStrict(ta.qstick(bars, { period: 10 }), get('qstick').outputs['real']!, 'qstick');
    assertStrict(ta.williamsAd(bars, {}), get('wad').outputs['real']!, 'wad');
    assertStrict(
      ta.marketFacilitationIndex(bars, {}),
      get('marketfi').outputs['real']!,
      'marketfi',
    );
  });

  it('msw is warmup-aligned to tulipy (first value at index = period)', () => {
    const e = get('msw');
    const sine = col(ta.msw(C, { period: 5 }), 'sine');
    // tulipy's lookback is `period` (5); TotalFinance must now agree (was one bar early before the fix)
    const tulipyFirst = e.outputs['sine']!.findIndex((x) => x != null);
    expect(tulipyFirst).toBe(5);
    expect(difference(sine, e.outputs['sine']!, 1e-7).firstQk).toBe(tulipyFirst);
  });

  it('msw sine/lead match tulipy except at isolated phase singularities', () => {
    const e = get('msw');
    const o = ta.msw(C, { period: 5 });
    for (const k of ['sine', 'lead'] as const) {
      const { compared, outliers } = difference(col(o, k), e.outputs[k]!, 1e-4);
      expect(compared, `msw.${k} compared`).toBeGreaterThan(200);
      // sine/lead are discontinuous where the in-phase component crosses zero; a hair of
      // floating-point noise flips the branch there. At most a couple of such singular bars differ.
      expect(outliers, `msw.${k} non-singular mismatches`).toBeLessThanOrEqual(2);
    }
  });
});
