import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ta from '@totalfinance/technical-analysis';
import {
  PANDAS_ASSERTED,
  PANDAS_EXACT,
  PANDAS_EXACT_SEED,
  PANDAS_FIXTURE_ONLY,
} from './golden/proof-manifest';

/**
 * Secondary parity: pandas-ta (the de-facto Python reference for the *modern* indicators TA-Lib
 * lacks — supertrend, vortex, choppiness, …). Expected values come from pandas-ta 0.4.x via
 * `tools/golden/generate_pandas_ta.py`. The exact groups assert COVERAGE (TotalFinance must produce a
 * value wherever pandas-ta does — no silent null-skip) and bit-for-bit values (~1e-7); the few
 * seed/convention-sensitive ones are split out. Differences are catalogued in talib-differences.md;
 * which fixtures are asserted vs reference-only lives in golden/proof-manifest.ts.
 */

interface Entry {
  name: string;
  parameters: Record<string, number>;
  outputs: Record<string, (number | null)[]>;
}
const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
const golden = load<{ entries: Entry[] }>('pandas-ta-golden.json');
const D = load<{
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}>('reference-ohlcv.json');
const C = D.close;
const H = D.high;
const L = D.low;
const bars = C.map((c, i) => ({
  open: D.open[i]!,
  high: H[i]!,
  low: L[i]!,
  close: c,
  volume: D.volume[i]!,
}));
type Series = readonly (number | null)[];
const col = (a: readonly unknown[], k: string): Series =>
  a.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));
const get = (n: string): Entry => golden.entries.find((e) => e.name === n)!;

interface Opt {
  relTol: number;
  absTol: number;
  from?: number;
  /** Require TotalFinance to produce a value wherever pandas-ta has one (catches silent null-skips). */
  requireCoverage?: boolean;
}
const live = (a: number | null | undefined): a is number => a != null && !Number.isNaN(a);

function assertSeries(actual: Series, expected: Series, label: string, o: Opt): number {
  let n = 0;
  // Coverage = no INTERNAL gaps: once TotalFinance starts emitting, it must have a value wherever
  // pandas-ta does. A longer LEADING warmup (TotalFinance starting a few bars later) is a documented
  // convention difference, not a hidden missing value, so coverage is enforced from TotalFinance's first
  // real value onward.
  const qkFirst = o.requireCoverage ? actual.findIndex(live) : -1;
  for (let i = o.from ?? 0; i < expected.length; i++) {
    const x = expected[i];
    if (x == null || Number.isNaN(x)) continue;
    const a = actual[i];
    if (o.requireCoverage && qkFirst >= 0 && i >= qkFirst) {
      expect(live(a), `${label}[${i}]: pandas-ta=${x} but TotalFinance has a gap (null/NaN)`).toBe(
        true,
      );
    }
    if (!live(a)) continue;
    const tolerance = Math.max(o.absTol, o.relTol * Math.abs(x));
    expect(Math.abs(a - x), `${label}[${i}] totalfinance=${a} pta=${x}`).toBeLessThanOrEqual(
      tolerance,
    );
    n++;
  }
  return n;
}

/** TotalFinance invocation for each single-output exact/seed name (drives the manifest-listed loops). */
const CALLS: Record<string, () => Series> = {
  ao: () => ta.awesomeOscillator(bars, { fast: 5, slow: 34 }),
  cmf: () => ta.chaikinMoneyFlow(bars, { period: 20 }),
  chop: () => ta.choppinessIndex(bars, { period: 14 }),
  coppock: () => ta.coppock(C, { longRoc: 14, shortRoc: 11, wma: 10 }),
  cti: () => ta.cti(C, { period: 12 }),
  massi: () => ta.massIndex(bars, { fast: 9, slow: 25 }),
  efi: () => ta.efi(bars, { period: 13 }),
  psl: () => ta.psychologicalLine(C, { period: 12 }),
  vhf: () => ta.verticalHorizontalFilter(C, { period: 28 }),
  ebsw: () => ta.ebsw(C, { period: 40, bars: 10 }),
  fwma: () => ta.fwma(C, { period: 10 }),
  hma: () => ta.hma(C, { period: 10 }),
  pwma: () => ta.pascalWma(C, { period: 10 }),
  sinwma: () => ta.sineWma(C, { period: 14 }),
  swma: () => ta.symmetricWma(C, { period: 10 }),
  vwma: () => ta.vwma(bars, { period: 10 }),
  zScore: () => ta.zScore(C, { period: 30 }),
  mad: () => ta.rollingMeanAbsoluteDeviation(C, { period: 30 }),
  skew: () => ta.skew(C, { period: 30 }),
  kurtosis: () => ta.kurtosis(C, { period: 30 }),
  median: () => ta.rollingMedian(C, { period: 30 }),
  ui: () => ta.ulcerIndex(C, { period: 14 }),
  pdist: () => ta.priceDistance(bars, {}),
  rma: () => ta.rma(C, { period: 10 }),
  zlma: () => ta.zlema(C, { period: 10 }),
};

describe('manifest integrity', () => {
  it('every committed fixture is classified exactly once (asserted or reference-only)', () => {
    const fixtures = golden.entries.map((e) => e.name).sort();
    const classified = [...PANDAS_ASSERTED, ...PANDAS_FIXTURE_ONLY].sort();
    expect(classified).toEqual(fixtures);
  });
  it('every exact/seed name has a TotalFinance invocation', () => {
    for (const name of [...PANDAS_EXACT, ...PANDAS_EXACT_SEED]) expect(CALLS[name]).toBeDefined();
  });
});

describe('pandas-ta parity — exact (with coverage)', () => {
  for (const name of PANDAS_EXACT) {
    it(`${name} matches pandas-ta everywhere it has a value`, () => {
      const n = assertSeries(CALLS[name]!(), get(name).outputs['real']!, name, {
        relTol: 1e-7,
        absTol: 1e-8,
        requireCoverage: true,
      });
      expect(n).toBeGreaterThan(50);
    });
  }
});

describe('pandas-ta parity — converges after the EMA/RMA seed transient (~1e-5)', () => {
  for (const name of PANDAS_EXACT_SEED) {
    it(`${name} converges to pandas-ta once the seed transient decays`, () => {
      // coverage is enforced from the first value; value parity from past the seed transient
      const n = assertSeries(CALLS[name]!(), get(name).outputs['real']!, name, {
        relTol: 1e-5,
        absTol: 1e-6,
        from: 30,
        requireCoverage: true,
      });
      expect(n).toBeGreaterThan(50);
    });
  }
});

describe('pandas-ta parity — multi-output (exact, with coverage)', () => {
  it('tsi (line + signal)', () => {
    const o = ta.tsi(C, { long: 25, short: 13, signal: 13 });
    const e = get('tsi');
    const opt = { relTol: 1e-7, absTol: 1e-8, requireCoverage: true } as const;
    expect(assertSeries(col(o, 'tsi'), e.outputs['real']!, 'tsi', opt)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'signal'), e.outputs['signal']!, 'tsi.signal', opt)).toBeGreaterThan(
      50,
    );
  });
  it('vortex (VI+ / VI−)', () => {
    const o = ta.vortex(bars, { period: 14 });
    const e = get('vortex');
    const opt = { relTol: 1e-7, absTol: 1e-8, requireCoverage: true } as const;
    expect(assertSeries(col(o, 'viPlus'), e.outputs['plus']!, 'vortex.plus', opt)).toBeGreaterThan(
      50,
    );
    expect(
      assertSeries(col(o, 'viMinus'), e.outputs['minus']!, 'vortex.minus', opt),
    ).toBeGreaterThan(50);
  });
  it('drawdown (abs / pct / log)', () => {
    const o = ta.drawdown(C, {});
    const e = get('drawdown');
    for (const k of ['drawdown', 'percent', 'log'] as const) {
      expect(
        assertSeries(col(o, k), e.outputs[k]!, `drawdown.${k}`, {
          relTol: 1e-7,
          absTol: 1e-8,
          from: 1,
          requireCoverage: true,
        }),
      ).toBeGreaterThan(100);
    }
  });
  it('cdlZ (OHLC z-scores, population std ddof 0)', () => {
    const o = ta.cdlZ(bars, { period: 30, ddof: 0 });
    const e = get('cdl_z');
    for (const k of ['open', 'high', 'low', 'close'] as const) {
      expect(
        assertSeries(col(o, k), e.outputs[k]!, `cdlZ.${k}`, {
          relTol: 1e-7,
          absTol: 1e-8,
          requireCoverage: true,
        }),
      ).toBeGreaterThan(50);
    }
  });
});

describe('pandas-ta parity — convention bridges (documented)', () => {
  it('alma matches pandas-ta within its window convention (~1e-2)', () => {
    expect(
      assertSeries(
        ta.alma(C, { period: 10, sigma: 6, offset: 0.85 }),
        get('alma').outputs['real']!,
        'alma',
        {
          relTol: 1e-2,
          absTol: 1e-2,
        },
      ),
    ).toBeGreaterThan(50);
  });
  it('bias matches pandas-ta ×100 (TotalFinance reports the bias as a percent)', () => {
    const scaled = get('bias').outputs['real']!.map((x) => (x == null ? null : x * 100));
    expect(
      assertSeries(ta.bias(C, { period: 26 }), scaled, 'bias×100', { relTol: 1e-6, absTol: 1e-7 }),
    ).toBeGreaterThan(50);
  });
  it('supertrend: direction matches exactly; line converges (shared ATR seed transient)', () => {
    const o = ta.supertrend(bars, { period: 7, multiplier: 3 });
    const e = get('supertrend');
    expect(
      assertSeries(col(o, 'direction'), e.outputs['dir']!, 'supertrend.dir', {
        relTol: 0,
        absTol: 0,
        from: 60,
      }),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'supertrend'), e.outputs['line']!, 'supertrend.line', {
        relTol: 2e-2,
        absTol: 2e-2,
        from: 60,
      }),
    ).toBeGreaterThan(50);
  });
  it('amat long/short run flags agree with pandas-ta on ≥90% of bars', () => {
    const o = ta.amat(C, { fast: 8, slow: 21, lookback: 2, movingAverageType: 'ema' });
    const e = get('amat');
    for (const k of ['long', 'short'] as const) {
      const exp = e.outputs[k]!;
      let agree = 0;
      let total = 0;
      for (let i = 45; i < exp.length; i++) {
        const a = (o[i] as unknown as Record<string, number> | null)?.[k];
        const x = exp[i];
        if (a == null || x == null) continue;
        total++;
        if (a === x) agree++;
      }
      expect(agree / total, `amat.${k} agreement ${(100 * agree) / total}%`).toBeGreaterThanOrEqual(
        0.9,
      );
    }
  });
});
