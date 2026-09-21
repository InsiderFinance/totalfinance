import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cmo } from '@totalfinance/technical-analysis/oscillators';
import { obv } from '@totalfinance/technical-analysis/bars';
import { stochRsi } from '@totalfinance/technical-analysis/oscillators';

/**
 * Opt-in `talib: true` compatibility modes — reproduce TA-Lib's value bit-for-bit for the documented
 * intentional divergences, on top of TotalFinance's default (TradingView/pandas-ta) convention. Asserted
 * against the committed TA-Lib 0.6.x golden vectors. Also re-verifies STOCHRSI, which matches TA-Lib
 * exactly under the right parameterization (TA-Lib's `fastk` is the raw %K → `kPeriod: 1`).
 */

const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
const g = load<{
  entries: Array<{
    fn: string;
    params: Record<string, number>; // external TA-Lib golden key — recorded evidence, not a TotalFinance name
    outputs: Record<string, (number | null)[]>;
  }>;
}>('talib-golden.json');
const D = load<{
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}>('reference-ohlcv.json');
const C = D.close;
const bars = C.map((c, i) => ({
  open: D.open[i]!,
  high: D.high[i]!,
  low: D.low[i]!,
  close: c,
  volume: D.volume[i]!,
}));
const get = (n: string) => g.entries.find((e) => e.fn === n)!;
const live = (a: number | null | undefined): a is number => a != null && !Number.isNaN(a);
const col = (a: readonly unknown[], k: string): (number | null)[] =>
  a.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));

function assertExact(actual: (number | null)[], expected: (number | null)[], label: string): void {
  let n = 0;
  for (let i = 0; i < expected.length; i++) {
    if (!live(expected[i])) continue;
    expect(live(actual[i]), `${label}[${i}]: TA-Lib has a value, TotalFinance null`).toBe(true);
    expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}]`).toBeLessThanOrEqual(1e-7);
    n++;
  }
  expect(n).toBeGreaterThan(50);
}

describe('talib:true compatibility modes (exact TA-Lib parity)', () => {
  it('CMO talib:true = TA-Lib Wilder CMO (2·RSI − 100)', () => {
    const e = get('CMO');
    assertExact(
      cmo(C, { period: e.params['timeperiod']!, talib: true }),
      e.outputs['real']!,
      'CMO',
    );
  });

  it('OBV talib:true = TA-Lib OBV (seeded at volume[0])', () => {
    assertExact(obv(bars, { talib: true }), get('OBV').outputs['real']!, 'OBV');
  });

  it('STOCHRSI matches TA-Lib exactly with kPeriod = 1 (TA-Lib fastk is the raw %K)', () => {
    const e = get('STOCHRSI');
    const o = stochRsi(C, {
      rsiPeriod: e.params['timeperiod']!,
      stochPeriod: e.params['fastk_period']!,
      kPeriod: 1,
      dPeriod: e.params['fastd_period']!,
    });
    assertExact(col(o, 'k'), e.outputs['fastk']!, 'STOCHRSI.fastk');
    assertExact(col(o, 'd'), e.outputs['fastd']!, 'STOCHRSI.fastd');
  });
});

describe('talib:true modes: default unchanged + stream/serialization parity', () => {
  it('CMO default still uses Chande simple sums (not the talib mode)', () => {
    const def = cmo(C, { period: 14 });
    const tal = cmo(C, { period: 14, talib: true });
    // the two conventions genuinely differ (Wilder vs simple sums)
    let difference = 0;
    for (let i = 0; i < C.length; i++)
      if (live(def[i]) && live(tal[i]))
        difference = Math.max(difference, Math.abs(def[i]! - tal[i]!));
    expect(difference).toBeGreaterThan(1);
  });

  it('CMO/OBV talib modes are batch≡stream and survive JSON round-trip mid-stream', () => {
    for (const run of [
      () => ({ ind: cmo, input: C as readonly unknown[], parameters: { period: 14, talib: true } }),
      () => ({ ind: obv, input: bars as readonly unknown[], parameters: { talib: true } }),
    ]) {
      const { ind, input, parameters } = run();
      const batch = (ind as (i: unknown, p: unknown) => (number | null)[])(input, parameters);
      const stream = (
        ind as {
          stream: (p: unknown) => { next: (v: unknown) => number | null; toJSON: () => unknown };
        }
      ).stream(parameters);
      const restore = (ind as { fromJSON: (s: unknown) => { next: (v: unknown) => number | null } })
        .fromJSON;
      const streamed: (number | null)[] = [];
      let s = stream;
      input.forEach((v, i) => {
        streamed.push(s.next(v));
        if (i === Math.floor(input.length / 2))
          s = restore(JSON.parse(JSON.stringify(s.toJSON()))) as typeof stream;
      });
      for (let i = 0; i < batch.length; i++) {
        if (live(batch[i]) || live(streamed[i]))
          expect(streamed[i], `batch≡stream@${i}`).toBe(batch[i]);
      }
    }
  });
});
