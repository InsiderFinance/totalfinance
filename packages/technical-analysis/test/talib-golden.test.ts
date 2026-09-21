import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ta from '@totalfinance/technical-analysis';
import { pairs } from '@totalfinance/technical-analysis/statistics';

/**
 * TA-Lib parity certification (the external "source of truth" suite).
 *
 * Every expected value here is produced by the TA-Lib 0.6.x C reference (via
 * `tools/golden/generate.py`) over the committed deterministic series
 * `golden/reference-ohlcv.json`, NOT by any TotalFinance code. We assert TotalFinance reproduces
 * TA-Lib exactly for every function with a single canonical definition, and — where TotalFinance
 * deliberately follows the TradingView/pandas-ta convention instead of TA-Lib's idiosyncratic
 * seeding — that it converges to TA-Lib once the seeding transient decays. The intentional
 * differences (and how to reproduce TA-Lib's exact value) are catalogued in
 * `docs/compatibility/talib-differences.md`.
 */

interface GoldenEntry {
  fn: string;
  group: string;
  params: Record<string, number | number[]>; // external TA-Lib golden key — recorded evidence
  outputs: Record<string, (number | null)[]>;
}
interface Golden {
  dataset: string;
  entries: GoldenEntry[];
}
interface Dataset {
  n: number;
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** Bounded (0.1, 0.9) series — in-domain for every element-wise math transform. */
  unit: number[];
}

const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8'),
  ) as T;

const golden = load<Golden>('talib-golden.json');
const D = load<Dataset>('reference-ohlcv.json');
const C = D.close;
const H = D.high;
const L = D.low;
const O = D.open;
const volume = D.volume;
const U = D.unit;
const bars = C.map((c, i) => ({
  open: O[i]!,
  high: H[i]!,
  low: L[i]!,
  close: c,
  volume: volume[i]!,
}));
/** Equal-H/L bars: the (H+L)/2 median price TotalFinance's MAMA uses then equals `close`, so it can be
 *  certified against TA-Lib's close-based MAMA. */
const flat = C.map((c) => ({ open: c, high: c, low: c, close: c, volume: 0 }));

type Series = readonly (number | null)[];
const col = (arr: readonly unknown[], k: string): Series =>
  arr.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));
const num = (v: number | null | undefined): number | null =>
  v == null || Number.isNaN(v) ? null : v;

/** Plain SMA over a possibly-null series (skips the warmup region cleanly — unlike the streaming
 *  accumulator, which would poison on a NaN). Used only to compose TA-Lib's slow stochastic. */
function smaLocal(x: Series, n: number): Series {
  const out: (number | null)[] = x.map(() => null);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      const v = x[j];
      if (v == null) {
        ok = false;
        break;
      }
      s += v;
    }
    if (ok) out[i] = s / n;
  }
  return out;
}

/** TA-Lib fn → TotalFinance aligned outputs (keyed by TA-Lib output name). Returns null when the fn is
 *  handled by a dedicated block (bridges) or is a documented difference. */
function dispatch(e: GoldenEntry): Record<string, Series> | null {
  const p = e.params as Record<string, number>;
  const per = p['timeperiod']!;
  const MA: Record<number, string> = {
    0: 'sma',
    1: 'ema',
    2: 'wma',
    3: 'dema',
    4: 'tema',
    5: 'trima',
    6: 'kama',
    8: 't3',
  };
  // element-wise math transforms (TA-Lib Math Transform) on the in-domain unit series
  const unary: Record<
    string,
    ((s: readonly number[], q: Record<string, never>) => number[]) | undefined
  > = {
    ACOS: ta.acos,
    ASIN: ta.asin,
    ATAN: ta.atan,
    CEIL: ta.ceil,
    COS: ta.cos,
    COSH: ta.cosh,
    EXP: ta.exp,
    FLOOR: ta.floor,
    LN: ta.ln,
    LOG10: ta.log10,
    SIN: ta.sin,
    SINH: ta.sinh,
    SQRT: ta.sqrt,
    TAN: ta.tan,
    TANH: ta.tanh,
  };
  if (unary[e.fn]) return { real: unary[e.fn]!(U, {}) };
  switch (e.fn) {
    // math operators (TA-Lib Math Operators) — element-wise on the high/low pair
    case 'ADD':
      return { real: ta.add(pairs(H, L), {}) };
    case 'SUB':
      return { real: ta.sub(pairs(H, L), {}) };
    case 'MULT':
      return { real: ta.mult(pairs(H, L), {}) };
    case 'DIV':
      return { real: ta.div(pairs(H, L), {}) };
    case 'SMA':
      return { real: ta.sma(C, { period: per }) };
    case 'EMA':
      return { real: ta.ema(C, { period: per }) };
    case 'WMA':
      return { real: ta.wma(C, { period: per }) };
    case 'DEMA':
      return { real: ta.dema(C, { period: per }) };
    case 'TEMA':
      return { real: ta.tema(C, { period: per }) };
    case 'TRIMA':
      return { real: ta.trima(C, { period: per }) };
    case 'KAMA':
      return { real: ta.kama(C, { period: per }) };
    case 'T3':
      return { real: ta.t3(C, { period: per, volumeFactor: p['vfactor']! }) };
    case 'MIDPOINT':
      return { real: ta.midpoint(C, { period: per }) };
    case 'MIDPRICE':
      return { real: ta.midprice(bars, { period: per }) };
    case 'SAR':
      return {
        real: col(ta.psar(bars, { step: p['acceleration']!, max: p['maximum']! }) as never, 'sar'),
      };
    case 'MA':
      return {
        real: ta.movingAverage(C, { period: per, movingAverageType: MA[p['matype']!] as never }),
      };
    case 'BBANDS': {
      const o = ta.bbands(C, { period: per, standardDeviation: p['nbdevup']! });
      return {
        upperband: col(o, 'upper'),
        middleband: col(o, 'middle'),
        lowerband: col(o, 'lower'),
      };
    }
    case 'RSI':
      return { real: ta.rsi(C, { period: per }) };
    case 'ROC':
      return { real: ta.roc(C, { period: per }) };
    case 'ROCP':
      return { real: ta.rocp(C, { period: per }) };
    case 'ROCR':
      return { real: ta.rocr(C, { period: per }) };
    case 'ROCR100':
      return { real: ta.rocr100(C, { period: per }) };
    case 'MOM':
      return { real: ta.momentum(C, { period: per }) };
    case 'TRIX':
      return { real: ta.trix(C, { period: per }) };
    case 'CCI':
      return { real: ta.cci(bars, { period: per }) };
    case 'WILLR':
      return { real: ta.williamsR(bars, { period: per }) };
    case 'MFI':
      return { real: ta.mfi(bars, { period: per }) };
    case 'AROONOSC':
      return { real: ta.aroonOscillator(bars, { period: per }) };
    case 'AROON': {
      const o = ta.aroon(bars, { period: per });
      return { aroonup: col(o, 'up'), aroondown: col(o, 'down') };
    }
    case 'BOP':
      return { real: ta.bop(bars, {}) };
    case 'ULTOSC':
      return {
        real: ta.ultimateOscillator(bars, {
          short: p['timeperiod1']!,
          medium: p['timeperiod2']!,
          long: p['timeperiod3']!,
        }),
      };
    case 'STOCHF': {
      const o = ta.stochastic(bars, { kPeriod: p['fastk_period']!, dPeriod: p['fastd_period']! });
      return { fastk: col(o, 'k'), fastd: col(o, 'd') };
    }
    case 'TRANGE':
      return { real: ta.trueRange(bars, {}) };
    case 'AVGPRICE':
      return { real: ta.averagePrice(bars, {}) };
    case 'MEDPRICE':
      return { real: ta.medianPrice(bars, {}) };
    case 'TYPPRICE':
      return { real: ta.typicalPrice(bars, {}) };
    case 'WCLPRICE':
      return { real: ta.weightedClose(bars, {}) };
    case 'AD':
      return { real: ta.adLine(bars, {}) };
    case 'ADOSC':
      return {
        real: ta.chaikinOscillator(bars, { fast: p['fastperiod']!, slow: p['slowperiod']! }),
      };
    case 'LINEARREG':
      return { real: col(ta.linreg(C, { period: per }) as never, 'value') };
    case 'LINEARREG_SLOPE':
      return { real: ta.linregSlope(C, { period: per }) };
    case 'LINEARREG_INTERCEPT':
      return { real: ta.linregIntercept(C, { period: per }) };
    case 'LINEARREG_ANGLE':
      return { real: ta.linregAngle(C, { period: per }) };
    case 'TSF':
      return { real: ta.tsf(C, { period: per }) };
    case 'CORREL':
      return { real: ta.correl(pairs(H, L), { period: per }) };
    case 'STDDEV':
      return { real: ta.standardDeviation(C, { period: per }) };
    case 'VAR':
      return { real: ta.variance(C, { period: per }) };
    case 'MAX':
      return { real: ta.rollingMax(C, { period: per }) };
    case 'MIN':
      return { real: ta.rollingMin(C, { period: per }) };
    case 'SUM':
      return { real: ta.rollingSum(C, { period: per }) };
    case 'MINMAX': {
      const o = ta.rollingMinMax(C, { period: per });
      return { min: col(o, 'min'), max: col(o, 'max') };
    }
    // ── seed-transient group: TotalFinance uses the TradingView/RMA convention; converges to TA-Lib ──
    case 'ATR':
      return { real: ta.atr(bars, { period: per }) };
    case 'NATR':
      return { real: ta.natr(bars, { period: per }) };
    case 'PLUS_DI':
      return { real: ta.plusDI(bars, { period: per }) };
    case 'MINUS_DI':
      return { real: ta.minusDI(bars, { period: per }) };
    case 'PLUS_DM':
      return { real: ta.plusDM(bars, { period: per }) };
    case 'MINUS_DM':
      return { real: ta.minusDM(bars, { period: per }) };
    case 'DX':
      return { real: ta.dx(bars, { period: per }) };
    case 'ADX':
      return { real: col(ta.adx(bars, { period: per }) as never, 'adx') };
    case 'ADXR':
      return { real: ta.adxr(bars, { period: per }) };
    // ── Hilbert family (approximate; Ehlers formulas vs TA-Lib's internal smoothing) ──
    case 'HT_DCPERIOD':
      return { real: ta.htDcPeriod(C, {}) };
    case 'HT_TRENDLINE':
      return { real: ta.htTrendline(C, {}) };
    case 'HT_PHASOR': {
      const o = ta.htPhasor(C, {});
      return { inphase: col(o, 'inPhase'), quadrature: col(o, 'quadrature') };
    }
    default:
      return null;
  }
}

/** Policy per TA-Lib fn: strict (exact within fp noise), or converge (late-series within a stated
 *  tolerance after the seeding/smoothing transient decays). */
const STRICT = new Set([
  'SMA',
  'EMA',
  'WMA',
  'DEMA',
  'TEMA',
  'TRIMA',
  'T3',
  'KAMA',
  'MIDPOINT',
  'MIDPRICE',
  'MA',
  'BBANDS',
  'RSI',
  'ROC',
  'ROCP',
  'ROCR',
  'ROCR100',
  'MOM',
  'TRIX',
  'CCI',
  'WILLR',
  'MFI',
  'AROONOSC',
  'AROON',
  'BOP',
  'ULTOSC',
  'STOCHF',
  'TRANGE',
  'AVGPRICE',
  'MEDPRICE',
  'TYPPRICE',
  'WCLPRICE',
  'AD',
  'LINEARREG',
  'LINEARREG_SLOPE',
  'LINEARREG_INTERCEPT',
  'LINEARREG_ANGLE',
  'TSF',
  'CORREL',
  'STDDEV',
  'VAR',
  'MAX',
  'MIN',
  'SUM',
  'MINMAX',
  // element-wise math transforms + operators (exact)
  'ACOS',
  'ASIN',
  'ATAN',
  'CEIL',
  'COS',
  'COSH',
  'EXP',
  'FLOOR',
  'LN',
  'LOG10',
  'SIN',
  'SINH',
  'SQRT',
  'TAN',
  'TANH',
  'ADD',
  'SUB',
  'MULT',
  'DIV',
]);
// `fromMul` scales the comparison start with the period: a Wilder/RMA seed transient decays like
// (1−1/period)^k, so larger periods need a later start before they reach TA-Lib's value.
const CONVERGE: Record<string, { from: number; fromMul?: number; relTol: number; absTol: number }> =
  {
    // PSAR is bit-exact once past the initial trend-direction seed (TA-Lib decides the first trend
    // from the opening +DM/−DM; TotalFinance converges to it after the first reversal).
    SAR: { from: 15, relTol: 1e-6, absTol: 1e-4 },
    ATR: { from: 40, fromMul: 5, relTol: 1e-3, absTol: 1e-3 },
    NATR: { from: 40, fromMul: 5, relTol: 1e-3, absTol: 1e-3 },
    ADOSC: { from: 60, relTol: 1e-3, absTol: 5 },
    PLUS_DI: { from: 50, fromMul: 6, relTol: 1.5e-2, absTol: 1e-2 },
    MINUS_DI: { from: 50, fromMul: 6, relTol: 1.5e-2, absTol: 1e-2 },
    PLUS_DM: { from: 50, fromMul: 6, relTol: 1.5e-2, absTol: 5e-2 },
    MINUS_DM: { from: 50, fromMul: 6, relTol: 1.5e-2, absTol: 5e-2 },
    DX: { from: 50, fromMul: 6, relTol: 1.5e-2, absTol: 1e-2 },
    ADX: { from: 60, fromMul: 6, relTol: 1.5e-2, absTol: 1e-2 },
    HT_DCPERIOD: { from: 70, relTol: 3e-2, absTol: 3e-2 },
    HT_TRENDLINE: { from: 90, relTol: 1e-2, absTol: 0.3 },
    HT_PHASOR: { from: 70, relTol: 5e-2, absTol: 5e-2 },
  };
/** Handled by dedicated `describe` blocks below (bridges) or catalogued as documented differences. */
const BRIDGED = new Set([
  'APO',
  'PPO',
  'STOCH',
  'STOCHRSI',
  'OBV',
  'MAVP',
  'MAMA',
  'MAXINDEX',
  'MININDEX',
  'MINMAXINDEX',
]);
const DOCUMENTED = new Set([
  'MACD',
  'MACDFIX',
  'CMO',
  'BETA',
  'ADXR',
  'HT_DCPHASE',
  'HT_SINE',
  'HT_TRENDMODE',
]);

function assertSeries(
  actual: Series,
  expected: Series,
  label: string,
  o: { relTol: number; absTol: number; from?: number; requireCoverage?: boolean },
): number {
  let compared = 0;
  for (let i = o.from ?? 0; i < expected.length; i++) {
    const x = num(expected[i]);
    if (x == null) continue;
    const a = num(actual[i]);
    if (o.requireCoverage) {
      expect(
        a,
        `${label}[${i}] expected a value (TA-Lib=${x}) but TotalFinance is null/NaN`,
      ).not.toBeNull();
    }
    if (a == null) continue;
    const tolerance = Math.max(o.absTol, o.relTol * Math.abs(x));
    expect(
      Math.abs(a - x),
      `${label}[${i}] totalfinance=${a} talib=${x} difference=${Math.abs(a - x)} > tolerance=${tolerance}`,
    ).toBeLessThanOrEqual(tolerance);
    compared++;
  }
  return compared;
}

describe('TA-Lib parity — strict (exact within floating-point noise)', () => {
  for (const e of golden.entries) {
    if (!STRICT.has(e.fn)) continue;
    const tag = `${e.fn}(${JSON.stringify(e.params)})`;
    it(`${tag} matches TA-Lib`, () => {
      const got = dispatch(e);
      expect(got, `${tag} dispatch`).not.toBeNull();
      let total = 0;
      for (const [oname, exp] of Object.entries(e.outputs)) {
        total += assertSeries(got![oname]!, exp, `${tag}.${oname}`, {
          relTol: 1e-6,
          absTol: 1e-7,
          requireCoverage: true,
        });
      }
      expect(total, `${tag} compared`).toBeGreaterThan(0);
    });
  }
});

describe('TA-Lib parity — converges after seeding transient (TradingView/RMA convention)', () => {
  for (const e of golden.entries) {
    const pol = CONVERGE[e.fn];
    if (!pol) continue;
    const tag = `${e.fn}(${JSON.stringify(e.params)})`;
    const period = (e.params as Record<string, number>)['timeperiod'] ?? 0;
    const from = Math.max(pol.from, Math.round((pol.fromMul ?? 0) * period));
    it(`${tag} converges to TA-Lib`, () => {
      const got = dispatch(e);
      expect(got, `${tag} dispatch`).not.toBeNull();
      let total = 0;
      for (const [oname, exp] of Object.entries(e.outputs)) {
        total += assertSeries(got![oname]!, exp, `${tag}.${oname}`, {
          relTol: pol.relTol,
          absTol: pol.absTol,
          from,
        });
      }
      expect(total, `${tag} compared`).toBeGreaterThan(0);
    });
  }
});

// ── bridges: TotalFinance follows a documented convention; transform to recover TA-Lib's value ──
describe('TA-Lib parity — convention bridges', () => {
  it('APO/PPO match TA-Lib with the EMA matype (TotalFinance/TradingView default)', () => {
    for (const e of golden.entries) {
      if (
        (e.fn !== 'APO' && e.fn !== 'PPO') ||
        (e.params as Record<string, number>)['matype'] !== 1
      )
        continue;
      const p = e.params as Record<string, number>;
      const act =
        e.fn === 'APO'
          ? ta.apo(C, { fast: p['fastperiod']!, slow: p['slowperiod']! })
          : col(ta.ppo(C, { fast: p['fastperiod']!, slow: p['slowperiod']! }) as never, 'ppo');
      // PPO gates output on its signal line (warms up later than TA-Lib's single-output PPO), so
      // compare where both are defined rather than requiring coverage.
      const n = assertSeries(act, e.outputs['real']!, `${e.fn}(ema)`, {
        relTol: 1e-6,
        absTol: 1e-7,
      });
      expect(n).toBeGreaterThan(0);
    }
  });

  it('STOCH (slow) = SMA-slowed raw %K (TotalFinance stochastic composes to TA-Lib STOCH)', () => {
    const e = golden.entries.find((x) => x.fn === 'STOCH')!;
    const p = e.params as Record<string, number>;
    const rawK = col(
      ta.stochastic(bars, { kPeriod: p['fastk_period']!, dPeriod: 1 }) as never,
      'k',
    );
    const slowK = smaLocal(rawK, p['slowk_period']!);
    const slowD = smaLocal(slowK, p['slowd_period']!);
    expect(
      assertSeries(slowK, e.outputs['slowk']!, 'STOCH.slowk', { relTol: 1e-6, absTol: 1e-7 }),
    ).toBeGreaterThan(0);
    expect(
      assertSeries(slowD, e.outputs['slowd']!, 'STOCH.slowd', { relTol: 1e-6, absTol: 1e-7 }),
    ).toBeGreaterThan(0);
  });

  it('STOCH (slow) via stochastic({ smoothK }) reproduces TA-Lib STOCH directly (certified)', () => {
    const e = golden.entries.find((x) => x.fn === 'STOCH')!;
    const p = e.params as Record<string, number>;
    const o = ta.stochastic(bars, {
      kPeriod: p['fastk_period']!,
      smoothK: p['slowk_period']!,
      dPeriod: p['slowd_period']!,
    });
    expect(
      assertSeries(col(o as never, 'k'), e.outputs['slowk']!, 'STOCH.smoothK.k', {
        relTol: 1e-6,
        absTol: 1e-7,
      }),
    ).toBeGreaterThan(0);
    expect(
      assertSeries(col(o as never, 'd'), e.outputs['slowd']!, 'STOCH.smoothK.d', {
        relTol: 1e-6,
        absTol: 1e-7,
      }),
    ).toBeGreaterThan(0);
  });

  it('OBV matches TA-Lib up to the seed constant (TA-Lib seeds at volume[0], TotalFinance at 0)', () => {
    const e = golden.entries.find((x) => x.fn === 'OBV')!;
    const totalfinance = ta.obv(bars, {});
    const shifted = totalfinance.map((v) => (v == null ? null : v + volume[0]!));
    expect(
      assertSeries(shifted, e.outputs['real']!, 'OBV+vol0', {
        relTol: 1e-9,
        absTol: 1e-3,
        requireCoverage: true,
      }),
    ).toBeGreaterThan(0);
  });

  it('MAXINDEX/MININDEX/MINMAXINDEX match TA-Lib absolute index (i − barsSince)', () => {
    const toAbs = (barsSince: Series): Series =>
      barsSince.map((v, i) => (v == null ? null : i - v));
    for (const e of golden.entries) {
      const p = e.params as Record<string, number>;
      // TA-Lib 0-fills the index outputs through the lookback; only compare from the first real index.
      const start = p['timeperiod']! - 1;
      const opt = { relTol: 0, absTol: 0, from: start, requireCoverage: true };
      if (e.fn === 'MAXINDEX') {
        const abs = toAbs(ta.rollingMaxIndex(C, { period: p['timeperiod']! }));
        expect(assertSeries(abs, e.outputs['integer']!, 'MAXINDEX', opt)).toBeGreaterThan(0);
      } else if (e.fn === 'MININDEX') {
        const abs = toAbs(ta.rollingMinIndex(C, { period: p['timeperiod']! }));
        expect(assertSeries(abs, e.outputs['integer']!, 'MININDEX', opt)).toBeGreaterThan(0);
      } else if (e.fn === 'MINMAXINDEX') {
        const o = ta.rollingMinMaxIndex(C, { period: p['timeperiod']! });
        const minAbs = toAbs(col(o as never, 'minIndex'));
        const maxAbs = toAbs(col(o as never, 'maxIndex'));
        expect(
          assertSeries(minAbs, e.outputs['minidx']!, 'MINMAXINDEX.minidx', opt),
        ).toBeGreaterThan(0);
        expect(
          assertSeries(maxAbs, e.outputs['maxidx']!, 'MINMAXINDEX.maxidx', opt),
        ).toBeGreaterThan(0);
      }
    }
  });

  it('MAVP matches TA-Lib for i ≥ maxPeriod−1 (variable-period SMA)', () => {
    const e = golden.entries.find((x) => x.fn === 'MAVP')!;
    const p = e.params as Record<string, number | number[]>;
    const periods = p['periods'] as number[];
    const out = ta.mavp({
      series: C,
      periods,
      parameters: {
        minPeriod: p['minperiod'] as number,
        maxPeriod: p['maxperiod'] as number,
        movingAverageType: 'sma',
      },
    });
    expect(
      assertSeries(out, e.outputs['real']!, 'MAVP', {
        relTol: 1e-6,
        absTol: 1e-7,
        from: (p['maxperiod'] as number) - 1,
        requireCoverage: true,
      }),
    ).toBeGreaterThan(0);
  });

  it('MAMA/FAMA match TA-Lib in steady state (equal-H/L bars → median price = close)', () => {
    const e = golden.entries.find((x) => x.fn === 'MAMA')!;
    const p = e.params as Record<string, number>;
    const o = ta.mama(flat, { fastLimit: p['fastlimit']!, slowLimit: p['slowlimit']! });
    expect(
      assertSeries(col(o, 'mama'), e.outputs['mama']!, 'MAMA.mama', {
        relTol: 3e-3,
        absTol: 3e-3,
        from: 50,
      }),
    ).toBeGreaterThan(0);
    expect(
      assertSeries(col(o, 'fama'), e.outputs['fama']!, 'MAMA.fama', {
        relTol: 2e-2,
        absTol: 2e-2,
        from: 50,
      }),
    ).toBeGreaterThan(0);
  });
});

// ── lock the documented-difference conventions so they can't silently drift ──
describe('documented differences (TotalFinance follows TradingView/pandas-ta, not TA-Lib)', () => {
  it('MACD line equals EMA(fast) − EMA(slow) (TradingView), not TA-Lib’s re-seeded line', () => {
    const m = ta.macd(C, { fast: 12, slow: 26, signal: 9 });
    const e12 = ta.ema(C, { period: 12 });
    const e26 = ta.ema(C, { period: 26 });
    for (let i = 0; i < C.length; i++) {
      const v = m[i]?.macd;
      if (v == null || Number.isNaN(v) || e12[i] == null || e26[i] == null) continue;
      expect(Math.abs(v - (e12[i]! - e26[i]!))).toBeLessThan(1e-9);
    }
  });

  it('CMO uses Chande’s original simple sums (pandas-ta default), not TA-Lib’s Wilder smoothing', () => {
    // independent simple-sum oracle (Chande): the value TA-Lib does NOT produce
    const n = 14;
    const out: (number | null)[] = C.map(() => null);
    for (let i = n; i < C.length; i++) {
      let up = 0;
      let dn = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const ch = C[j]! - C[j - 1]!;
        if (ch > 0) up += ch;
        else dn += -ch;
      }
      out[i] = up + dn === 0 ? 0 : (100 * (up - dn)) / (up + dn);
    }
    expect(
      assertSeries(ta.cmo(C, { period: 14 }), out, 'CMO(simple)', { relTol: 1e-9, absTol: 1e-9 }),
    ).toBeGreaterThan(0);
  });
});

// ── completeness guard: every committed golden entry is accounted for by a policy above ──
describe('coverage guard', () => {
  it('every TA-Lib golden entry is strict, converging, bridged, or documented', () => {
    const orphans = new Set<string>();
    for (const e of golden.entries) {
      if (STRICT.has(e.fn) || CONVERGE[e.fn] || BRIDGED.has(e.fn) || DOCUMENTED.has(e.fn)) continue;
      orphans.add(e.fn);
    }
    expect([...orphans], `uncategorized TA-Lib functions: ${[...orphans].join(', ')}`).toEqual([]);
  });
});
