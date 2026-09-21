import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ta from '@totalfinance/technical-analysis';
import { standardDeviation } from '@totalfinance/technical-analysis/volatility';
import { adx as adxFn } from '@totalfinance/technical-analysis/bars';
import { PANDAS_EXT_ASSERTED, PANDAS_EXT_FIXTURE_ONLY } from './golden/proof-manifest';

/**
 * Long-tail parity against **pandas-ta** — the second wave, covering the indicators that previously
 * had only name-resolution coverage (kdj, qqe, squeeze, ttm_trend, aberration, …). Expected values
 * come from `tools/golden/generate_pandas_ta_ext.py`. Exact groups assert COVERAGE (TotalFinance emits a
 * value wherever pandas-ta does) plus bit-for-bit values; seed-sensitive ones converge from an
 * offset; a few are exact only after a documented percent-scale convention. Which fixtures are
 * asserted vs reference-only (documented different definition) lives in golden/proof-manifest.ts and
 * is mirrored in docs/compatibility/talib-differences.md.
 */

interface Entry {
  name: string;
  parameters: Record<string, unknown>;
  outputs: Record<string, (number | null)[]>;
}
const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
const golden = load<{ entries: Entry[] }>('pandas-ta-ext-golden.json');
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
type Series = readonly (number | null)[];
const get = (n: string): Entry => golden.entries.find((e) => e.name === n)!;
const out = (n: string, k = 'real'): Series => get(n).outputs[k]!;
const col = (a: readonly unknown[], k: string): Series =>
  a.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));
const live = (a: number | null | undefined): a is number => a != null && !Number.isNaN(a);
const scale = (s: Series, f: number): Series => s.map((x) => (x == null ? null : x * f));

interface Opt {
  relTol: number;
  absTol: number;
  from?: number;
  /** Require TotalFinance to produce a value wherever pandas-ta has one (catches silent null-skips). */
  requireCoverage?: boolean;
}
function assertSeries(actual: Series, expected: Series, label: string, o: Opt): number {
  let n = 0;
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

// TotalFinance invocation per single-output exact fixture (snake_case fixture name → series).
const SINGLE: Record<string, () => Series> = {
  decreasing: () => ta.decreasing(C, { period: 3 }),
  increasing: () => ta.increasing(C, { period: 3 }),
  er: () => ta.efficiencyRatio(C, { period: 10 }),
  hwma: () =>
    ta.holtWinterMovingAverage(C, {
      levelSmoothing: 0.2,
      trendSmoothing: 0.1,
      accelerationSmoothing: 0.1,
    }),
  log_return: () => ta.logReturns(C, {}),
  percent_return: () => ta.returns(C, {}),
  mcgd: () => ta.mcginley(C, { period: 10 }),
  quantile: () => ta.rollingQuantile(C, { period: 30, quantile: 0.5 }),
  slope: () => ta.slope(C, { period: 5 }),
  eom: () => ta.easeOfMovement(bars, { period: 14 }),
  pvol: () => ta.priceVolume(bars, {}),
  pvr: () => ta.priceVolumeRank(bars, {}),
  ttm_trend: () => ta.ttmTrend(bars, { period: 6 }),
  // pandas-ta's CFO is the one-bar TSF-forecast variant → TotalFinance's forecastOscillator.
  cfo: () => ta.forecastOscillator(C, { period: 9 }),
};

describe('manifest integrity (pandas-ta-ext)', () => {
  it('classifies every committed fixture exactly once (asserted or reference-only)', () => {
    const fixtures = golden.entries.map((e) => e.name).sort();
    const classified = [...PANDAS_EXT_ASSERTED, ...PANDAS_EXT_FIXTURE_ONLY].sort();
    expect(classified).toEqual(fixtures);
  });
});

describe('pandas-ta-ext — exact single-output (with coverage)', () => {
  for (const name of Object.keys(SINGLE)) {
    it(`${name} matches pandas-ta everywhere it has a value`, () => {
      const n = assertSeries(SINGLE[name]!(), out(name), name, {
        relTol: 1e-6,
        absTol: 1e-7,
        requireCoverage: true,
      });
      expect(n).toBeGreaterThan(50);
    });
  }
});

describe('pandas-ta-ext — exact multi-output (with coverage)', () => {
  const exact = { relTol: 1e-6, absTol: 1e-7, requireCoverage: true } as const;
  it('accbands (lower / mid / upper)', () => {
    const o = ta.accelerationBands(bars, { period: 20, multiplier: 4 });
    expect(
      assertSeries(col(o, 'lower'), out('accbands', 'lower'), 'accbands.lower', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'middle'), out('accbands', 'mid'), 'accbands.mid', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'upper'), out('accbands', 'upper'), 'accbands.upper', exact),
    ).toBeGreaterThan(50);
  });
  it('brar (ar / br)', () => {
    const o = ta.brar(bars, { period: 26 });
    // `col(o, …)` reads OUR output fields (renamed); `out('brar', …)` reads pandas-ta's golden
    // columns, whose names are not ours to change.
    expect(
      assertSeries(col(o, 'popularityIndex'), out('brar', 'ar'), 'brar.ar', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'willingnessIndex'), out('brar', 'br'), 'brar.br', exact),
    ).toBeGreaterThan(50);
  });
  it('donchian (lower / mid / upper)', () => {
    const o = ta.donchian(bars, { period: 20 });
    expect(
      assertSeries(col(o, 'lower'), out('donchian', 'lower'), 'donchian.lower', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'middle'), out('donchian', 'mid'), 'donchian.mid', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'upper'), out('donchian', 'upper'), 'donchian.upper', exact),
    ).toBeGreaterThan(50);
  });
  it('elderRay (bull / bear)', () => {
    const o = ta.elderRay(bars, { period: 13 });
    expect(assertSeries(col(o, 'bull'), out('eri', 'bull'), 'eri.bull', exact)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'bear'), out('eri', 'bear'), 'eri.bear', exact)).toBeGreaterThan(50);
  });
  it('heikinAshi (open / high / low / close)', () => {
    const o = ta.heikinAshi(bars, {});
    for (const k of ['open', 'high', 'low', 'close'] as const) {
      expect(assertSeries(col(o, k), out('ha', k), `ha.${k}`, exact)).toBeGreaterThan(50);
    }
  });
  it('ichimoku (tenkan / kijun — the unshifted lines)', () => {
    const o = ta.ichimoku(bars, { conversion: 9, base: 26, spanB: 52 });
    expect(
      assertSeries(col(o, 'tenkan'), out('ichimoku', 'tenkan'), 'ichimoku.tenkan', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'kijun'), out('ichimoku', 'kijun'), 'ichimoku.kijun', exact),
    ).toBeGreaterThan(50);
  });
  it('pvo (pvo / histogram / signal)', () => {
    const o = ta.pvo(bars, { fast: 12, slow: 26, signal: 9 });
    expect(assertSeries(col(o, 'pvo'), out('pvo', 'pvo'), 'pvo.pvo', exact)).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'histogram'), out('pvo', 'hist'), 'pvo.hist', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'signal'), out('pvo', 'signal'), 'pvo.signal', exact),
    ).toBeGreaterThan(50);
  });
  it('relativeVigorIndex (rvgi / signal)', () => {
    const o = ta.relativeVigorIndex(bars, { period: 14 });
    expect(assertSeries(col(o, 'rvi'), out('rvgi', 'rvgi'), 'rvgi.rvgi', exact)).toBeGreaterThan(
      50,
    );
    expect(
      assertSeries(col(o, 'signal'), out('rvgi', 'signal'), 'rvgi.signal', exact),
    ).toBeGreaterThan(50);
  });
  it('elderThermometer (thermo / movingAverage)', () => {
    const o = ta.elderThermometer(bars, { period: 20, long: 2, short: 0.5 });
    expect(
      assertSeries(col(o, 'thermo'), out('thermo', 'thermo'), 'thermo.thermo', exact),
    ).toBeGreaterThan(50);
    // `col(o, …)` reads OUR output field (renamed); `out('thermo', 'ma')` reads the pandas-ta golden
    // column, whose name is not ours to change.
    expect(
      assertSeries(col(o, 'movingAverage'), out('thermo', 'ma'), 'thermo.ma', exact),
    ).toBeGreaterThan(50);
  });
  it('qqe (RSI MA line)', () => {
    const o = ta.qqe(C, { rsiPeriod: 14, smooth: 5, factor: 4.236 });
    expect(
      assertSeries(col(o, 'rsiMovingAverage'), out('qqe', 'rsima'), 'qqe.rsima', exact),
    ).toBeGreaterThan(50);
  });
  it('stochRsi (k / d — within the RSI Wilder seed transient)', () => {
    const o = ta.stochRsi(C, { rsiPeriod: 14, stochPeriod: 14, kPeriod: 3, dPeriod: 3 });
    const near = { relTol: 1e-4, absTol: 1e-4, requireCoverage: true } as const;
    expect(assertSeries(col(o, 'k'), out('stochrsi', 'k'), 'stochrsi.k', near)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'd'), out('stochrsi', 'd'), 'stochrsi.d', near)).toBeGreaterThan(50);
  });
  /**
   * OUR field names are `zeroLine`/`upperBand`/`lowerBand`; the reference fixture's columns are
   * pandas-ta's `zg`/`sg`/`xg`. A rename sweep rewrote the lookup keys into the golden data too,
   * which asked it for columns it has never had — the reference is a foreign artifact and its
   * spelling is not ours to change.
   */
  it('aberration (zeroLine exact; upperBand/lowerBand/atr within the ATR seed transient)', () => {
    const o = ta.aberration(bars, { period: 5, atrPeriod: 15 });
    expect(
      assertSeries(col(o, 'zeroLine'), out('aberration', 'zg'), 'aberration.zeroLine', exact),
    ).toBeGreaterThan(50);
    const near = { relTol: 1e-3, absTol: 1e-3, requireCoverage: true } as const;
    expect(
      assertSeries(col(o, 'upperBand'), out('aberration', 'sg'), 'aberration.upperBand', near),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'lowerBand'), out('aberration', 'xg'), 'aberration.lowerBand', near),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'atr'), out('aberration', 'atr'), 'aberration.atr', {
        relTol: 1e-2,
        absTol: 1e-2,
        from: 60,
      }),
    ).toBeGreaterThan(50);
  });
  it('chandeKrollStop (long / short)', () => {
    const o = ta.chandeKrollStop(bars, { atrPeriod: 10, multiplier: 3, period: 20 });
    const near = { relTol: 1e-3, absTol: 1e-3 } as const;
    expect(assertSeries(col(o, 'long'), out('cksp', 'long'), 'cksp.long', near)).toBeGreaterThan(
      50,
    );
    expect(assertSeries(col(o, 'short'), out('cksp', 'short'), 'cksp.short', near)).toBeGreaterThan(
      50,
    );
  });
  it('keltner (mid exact; bands within the range-EMA-vs-ATR convention)', () => {
    const o = ta.keltner(bars, { period: 20, atrPeriod: 10, multiplier: 2 });
    expect(assertSeries(col(o, 'middle'), out('kc', 'mid'), 'kc.mid', exact)).toBeGreaterThan(50);
    const near = { relTol: 1e-3, absTol: 1e-3 } as const;
    expect(assertSeries(col(o, 'lower'), out('kc', 'lower'), 'kc.lower', near)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'upper'), out('kc', 'upper'), 'kc.upper', near)).toBeGreaterThan(50);
  });
});

describe('pandas-ta-ext — converges after a seed transient (from an offset)', () => {
  it('superSmoother (ssf) converges to pandas-ta', () => {
    expect(
      assertSeries(ta.superSmoother(C, { period: 10 }), out('ssf'), 'ssf', {
        relTol: 2e-2,
        absTol: 2e-2,
        from: 30,
      }),
    ).toBeGreaterThan(50);
  });
  it('holtWinterChannel (mid exact; bands converge)', () => {
    const o = ta.holtWinterChannel(C, {
      levelSmoothing: 0.2,
      trendSmoothing: 0.1,
      accelerationSmoothing: 0.1,
      varianceSmoothing: 0.1,
      scalar: 1,
    });
    expect(
      assertSeries(col(o, 'middle'), out('hwc', 'mid'), 'hwc.mid', {
        relTol: 1e-6,
        absTol: 1e-7,
        requireCoverage: true,
      }),
    ).toBeGreaterThan(50);
    const near = { relTol: 2e-2, absTol: 2e-2, from: 30 } as const;
    expect(assertSeries(col(o, 'lower'), out('hwc', 'lower'), 'hwc.lower', near)).toBeGreaterThan(
      50,
    );
    expect(assertSeries(col(o, 'upper'), out('hwc', 'upper'), 'hwc.upper', near)).toBeGreaterThan(
      50,
    );
  });
  it('adx converges to pandas-ta (shared Wilder RMA seed transient)', () => {
    expect(
      assertSeries(col(ta.adx(bars, { period: 14 }), 'adx'), out('adx', 'adx'), 'adx', {
        relTol: 2e-2,
        absTol: 2e-2,
        from: 80,
      }),
    ).toBeGreaterThan(50);
  });
  it('dmi (+DM / −DM) converges to pandas-ta dm', () => {
    const o = ta.dmi(bars, { period: 14 });
    const near = { relTol: 2e-2, absTol: 2e-2, from: 80 } as const;
    expect(assertSeries(col(o, 'plusDM'), out('dm', 'plus'), 'dm.plus', near)).toBeGreaterThan(40);
    expect(assertSeries(col(o, 'minusDM'), out('dm', 'minus'), 'dm.minus', near)).toBeGreaterThan(
      40,
    );
  });
  it('rsx converges to pandas-ta once the Jurik cascade seeds', () => {
    expect(
      assertSeries(ta.rsx(C, { period: 14 }), out('rsx'), 'rsx', {
        relTol: 1e-2,
        absTol: 1e-2,
        from: 60,
      }),
    ).toBeGreaterThan(50);
  });
  it('kdj (k / d / j) converges to pandas-ta', () => {
    const o = ta.kdj(bars, { period: 9, signal: 3 });
    const near = { relTol: 2e-2, absTol: 2e-2, from: 60 } as const;
    expect(assertSeries(col(o, 'k'), out('kdj', 'k'), 'kdj.k', near)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'd'), out('kdj', 'd'), 'kdj.d', near)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'j'), out('kdj', 'j'), 'kdj.j', near)).toBeGreaterThan(50);
  });
});

describe('pandas-ta-ext — exact after a documented percent-scale convention', () => {
  const exact = { relTol: 1e-6, absTol: 1e-6 } as const;
  it('pvt = pandas-ta ÷ 100 (TotalFinance reports raw-fraction price-volume trend)', () => {
    expect(
      assertSeries(scale(ta.pvt(bars, {}), 100), out('pvt'), 'pvt×100', exact),
    ).toBeGreaterThan(50);
  });
  it('kst = pandas-ta ÷ 100 (TotalFinance ROCs are fractions, pandas-ta uses percent)', () => {
    const o = ta.kst(C, { rocPeriods: [10, 15, 20, 30], smaPeriods: [10, 10, 10, 15], signal: 9 });
    expect(
      assertSeries(scale(col(o, 'kst'), 100), out('kst', 'kst'), 'kst×100', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(scale(col(o, 'signal'), 100), out('kst', 'signal'), 'kst.signal×100', exact),
    ).toBeGreaterThan(50);
  });
  it('smiErgodic = pandas-ta ×100 (TotalFinance reports the SMI as a percent, scalar 100)', () => {
    const o = ta.smiErgodic(C, { long: 20, short: 5, signal: 5 });
    expect(
      assertSeries(col(o, 'smi'), scale(out('smi', 'smi'), 100), 'smi', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'signal'), scale(out('smi', 'signal'), 100), 'smi.signal', exact),
    ).toBeGreaterThan(50);
    expect(
      assertSeries(col(o, 'oscillator'), scale(out('smi', 'osc'), 100), 'smi.osc', exact),
    ).toBeGreaterThan(50);
  });
});

describe('pandas-ta-ext — exact integer signal', () => {
  it('squeeze on-state flag matches pandas-ta SQZ_ON exactly', () => {
    const o = ta.squeeze(bars, {
      bollingerBandPeriod: 20,
      bollingerStandardDeviations: 2,
      keltnerChannelPeriod: 20,
      keltnerChannelMultiplier: 1.5,
    });
    expect(
      assertSeries(col(o, 'on'), out('squeeze', 'on'), 'squeeze.on', { relTol: 0, absTol: 0 }),
    ).toBeGreaterThan(50);
  });
});

// ── closed-form / structural oracles (no external library; TotalFinance-internal identities) ──
describe('pandas-ta-ext — closed-form oracles', () => {
  it('adxr = (adx + adx[period bars ago]) / 2 (classic ADXR composition)', () => {
    const period = 14;
    const adx = col(adxFn(bars, { period }), 'adx');
    const adxr = ta.adxr(bars, { period }) as (number | null)[];
    const expected = adxr.map((_, i) =>
      live(adx[i]) && live(adx[i - period]) ? (adx[i]! + adx[i - period]!) / 2 : null,
    );
    expect(assertSeries(adxr, expected, 'adxr', { relTol: 1e-9, absTol: 1e-9 })).toBeGreaterThan(
      50,
    );
  });
  it('standardError = sampleStddev / √period', () => {
    const period = 14;
    const sd = standardDeviation(C, { period, sample: true }) as (number | null)[];
    const se = ta.standardError(C, { period }) as (number | null)[];
    const expected = sd.map((x) => (live(x) ? x / Math.sqrt(period) : null));
    expect(
      assertSeries(se, expected, 'standardError', { relTol: 1e-9, absTol: 1e-9 }),
    ).toBeGreaterThan(50);
  });
  it('lag(period) shifts the series by exactly `period` bars', () => {
    const period = 3;
    const lagged = ta.lag(C, { period }) as (number | null)[];
    const expected = C.map((_, i) => (i >= period ? C[i - period]! : null));
    expect(assertSeries(lagged, expected, 'lag', { relTol: 0, absTol: 0 })).toBeGreaterThan(50);
  });
  it('centralPivotRange = prior-bar pivot / TC / BC (closed form)', () => {
    const o = ta.centralPivotRange(bars, {});
    const piv = bars.map((_, i) =>
      i >= 1 ? (bars[i - 1]!.high + bars[i - 1]!.low + bars[i - 1]!.close) / 3 : null,
    );
    const bc = bars.map((_, i) => (i >= 1 ? (bars[i - 1]!.high + bars[i - 1]!.low) / 2 : null));
    const tc = piv.map((p, i) => (live(p) && live(bc[i]) ? 2 * p - bc[i]! : null));
    const exact = { relTol: 1e-9, absTol: 1e-9 } as const;
    expect(assertSeries(col(o, 'pivot'), piv, 'cpr.pivot', exact)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'bottomCentral'), bc, 'cpr.bc', exact)).toBeGreaterThan(50);
    expect(assertSeries(col(o, 'topCentral'), tc, 'cpr.tc', exact)).toBeGreaterThan(50);
  });
});
