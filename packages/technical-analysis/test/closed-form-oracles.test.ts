import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ta from '@totalfinance/technical-analysis';

/**
 * Closed-form / structural correctness oracles. These do NOT assert external-library parity — they
 * recompute each indicator's **published defining formula** from TotalFinance's own golden-certified
 * primitives (SMA/EMA/VWMA/ATR/STDDEV/LINREG/TRIX/OBV — all proven in talib-golden /
 * pandas-ta-golden) and assert the indicator equals that composition. This certifies the
 * implementation is internally correct (no off-by-one, seed, sign or coefficient bug) for the long
 * tail where no external library agrees on a single convention (or has no entry at all). The proof
 * rests on the certified primitives; the oracle formula is written independently from the standard
 * definition, not transcribed from the implementation.
 */

const load = <T>(n: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${n}`, import.meta.url)), 'utf8')) as T;
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
const V = D.volume;
const bars = C.map((c, i) => ({
  open: D.open[i]!,
  high: H[i]!,
  low: L[i]!,
  close: c,
  volume: V[i]!,
}));
const typical = bars.map((b) => (b.high + b.low + b.close) / 3);

type Num = number | null;
type Series = readonly Num[];
const live = (a: Num | undefined): a is number => a != null && !Number.isNaN(a);
const col = (a: readonly unknown[], k: string): Series =>
  a.map((p) => (p == null ? null : ((p as Record<string, number>)[k] ?? null)));

// certified primitives as oracle building blocks
const sma = (s: Series, p: number): Series => ta.sma(s as number[], { period: p });
const ema = (s: Series, p: number): Series => ta.ema(s as number[], { period: p });
const stddevS = (s: Series, p: number, sample: boolean): Series =>
  ta.standardDeviation(s as number[], { period: p, sample });
const trixS = (s: Series, p: number): Series => ta.trix(s as number[], { period: p });

/** EMA over a series that has leading nulls (e.g. a MACD line): compact the live values, run the
 *  certified EMA on the dense array, then scatter back to the original indices — exactly how a
 *  streaming signal EMA is fed the macd line bar by bar starting at its first value. */
function emaSparse(s: Series, p: number): Series {
  const idx: number[] = [];
  const dense: number[] = [];
  s.forEach((v, i) => {
    if (live(v)) {
      idx.push(i);
      dense.push(v);
    }
  });
  const e = ta.ema(dense, { period: p });
  const out: Num[] = new Array(s.length).fill(null);
  idx.forEach((origI, j) => (out[origI] = e[j] ?? null));
  return out;
}

/** Wilder RMA over a series with leading nulls — compact, run certified RMA, scatter back. */
function rmaSparse(s: Series, p: number): Series {
  const idx: number[] = [];
  const dense: number[] = [];
  s.forEach((v, i) => {
    if (live(v)) {
      idx.push(i);
      dense.push(v);
    }
  });
  const r = ta.rma(dense, { period: p });
  const out: Num[] = new Array(s.length).fill(null);
  idx.forEach((origI, j) => (out[origI] = r[j] ?? null));
  return out;
}

/** OLS linear-regression endpoint value (TA-Lib LINEARREG) over the trailing `p` bars. */
function linregEndpoint(s: Series, p: number): Series {
  let sx = 0;
  let sxx = 0;
  for (let k = 0; k < p; k++) {
    sx += k;
    sxx += k * k;
  }
  return s.map((_, i) => {
    if (i < p - 1 || !live(s[i])) return null;
    let sy = 0;
    let sxy = 0;
    for (let k = 0; k < p; k++) {
      const y = s[i - p + 1 + k];
      if (!live(y)) return null;
      sy += y;
      sxy += k * y;
    }
    const b = (p * sxy - sx * sy) / (p * sxx - sx * sx);
    const a = (sy - b * sx) / p;
    return a + b * (p - 1);
  });
}

/** OLS slope over the trailing `p` bars (x = 0..p−1). */
function linregSlope(s: Series, p: number): Series {
  let sx = 0;
  let sxx = 0;
  for (let k = 0; k < p; k++) {
    sx += k;
    sxx += k * k;
  }
  return s.map((_, i) => {
    if (i < p - 1) return null;
    let sy = 0;
    let sxy = 0;
    for (let k = 0; k < p; k++) {
      const y = s[i - p + 1 + k]!;
      sy += y;
      sxy += k * y;
    }
    return (p * sxy - sx * sy) / (p * sxx - sx * sx);
  });
}

/** linregEndpoint over a series that warms up late (has leading nulls): compact, regress, scatter. */
function linregEndpointSparse(s: Series, p: number): Series {
  const idx: number[] = [];
  const dense: number[] = [];
  s.forEach((v, i) => {
    if (live(v)) {
      idx.push(i);
      dense.push(v);
    }
  });
  const e = linregEndpoint(dense, p);
  const out: Num[] = new Array(s.length).fill(null);
  idx.forEach((origI, j) => (out[origI] = e[j] ?? null));
  return out;
}

/** Assert `actual` equals `expected` everywhere both are live, from `from`, within tolerance. */
function same(
  actual: Series,
  expected: Series,
  label: string,
  relTol = 1e-9,
  absTol = 1e-9,
  from = 0,
): void {
  let n = 0;
  for (let i = from; i < expected.length; i++) {
    const x = expected[i];
    const a = actual[i];
    if (!live(x) || !live(a)) continue;
    const tolerance = Math.max(absTol, relTol * Math.abs(x));
    expect(Math.abs(a - x), `${label}[${i}] totalfinance=${a} oracle=${x}`).toBeLessThanOrEqual(
      tolerance,
    );
    n++;
  }
  expect(n, `${label}: too few compared`).toBeGreaterThan(40);
}

describe('closed-form oracles — volume', () => {
  it('volumeOscillator = 100·(EMA(vol,fast) − EMA(vol,slow)) / EMA(vol,slow)', () => {
    const f = ema(V, 5);
    const s = ema(V, 10);
    const oracle = f.map((fv, i) =>
      live(fv) && live(s[i]) && s[i]! !== 0 ? (100 * (fv - s[i]!)) / s[i]! : null,
    );
    same(ta.volumeOscillator(bars, { fast: 5, slow: 10 }), oracle, 'volumeOscillator');
  });

  it('volumeWeightedMacd = VWMA(fast) − VWMA(slow), signal = EMA(macd)', () => {
    const fast = ta.vwma(bars, { period: 12 });
    const slow = ta.vwma(bars, { period: 26 });
    const macd = fast.map((fv, i) => (live(fv) && live(slow[i]) ? fv - slow[i]! : null));
    const signal = emaSparse(macd, 9);
    const o = ta.volumeWeightedMacd(bars, { fast: 12, slow: 26, signal: 9 });
    same(col(o, 'macd'), macd, 'vwmacd.macd');
    same(col(o, 'signal'), signal, 'vwmacd.signal');
    same(
      col(o, 'histogram'),
      macd.map((m, i) => (live(m) && live(signal[i]) ? m - signal[i]! : null)),
      'vwmacd.histogram',
    );
  });

  it('archerObv obv/fast/slow = OBV and its EMAs', () => {
    const obv = ta.obv(bars, {});
    const fast = ema(obv, 4);
    const slow = ema(obv, 12);
    const o = ta.archerObv(bars, { fast: 4, slow: 12, runLength: 2 });
    same(col(o, 'obv'), obv, 'archerObv.obv');
    same(col(o, 'fast'), fast, 'archerObv.fast');
    same(col(o, 'slow'), slow, 'archerObv.slow');
  });

  it('nvi = 1000·∏(1 + ROC) over volume-decrease bars (classic Fosback)', () => {
    const oracle: Num[] = [];
    let idx = 1000;
    let pc: number | null = null;
    let pv = 0;
    for (let i = 0; i < C.length; i++) {
      if (pc !== null && V[i]! < pv && pc !== 0) idx *= 1 + (C[i]! - pc) / pc;
      oracle.push(idx);
      pc = C[i]!;
      pv = V[i]!;
    }
    same(ta.nvi(bars, {}), oracle, 'nvi');
  });

  it('pvi = 1000·∏(1 + ROC) over volume-increase bars (classic Fosback)', () => {
    const oracle: Num[] = [];
    let idx = 1000;
    let pc: number | null = null;
    let pv = 0;
    for (let i = 0; i < C.length; i++) {
      if (pc !== null && V[i]! > pv && pc !== 0) idx *= 1 + (C[i]! - pc) / pc;
      oracle.push(idx);
      pc = C[i]!;
      pv = V[i]!;
    }
    same(ta.pvi(bars, {}), oracle, 'pvi');
  });
});

describe('closed-form oracles — volatility', () => {
  it('chaikinVolatility = ROC of EMA(high − low) over rocPeriod', () => {
    const hl = bars.map((b) => b.high - b.low);
    const e = ema(hl, 10);
    const oracle = e.map((ev, i) =>
      i >= 10 && live(ev) && live(e[i - 10]) && e[i - 10]! !== 0
        ? (100 * (ev - e[i - 10]!)) / e[i - 10]!
        : null,
    );
    same(ta.chaikinVolatility(bars, { period: 10, rocPeriod: 10 }), oracle, 'chaikinVolatility');
  });

  it('historicalVolatility = STDDEV(logReturns) · √annualization', () => {
    const lr = ta.logReturns(C, {});
    const sd = stddevS(lr, 20, true);
    const oracle = sd.map((s) => (live(s) ? s * Math.sqrt(252) : null));
    same(
      ta.historicalVolatility(C, { period: 20, annualization: 252 }),
      oracle,
      'historicalVolatility',
      1e-6,
      1e-7,
    );
  });
});

describe('closed-form oracles — moving averages', () => {
  it('dsp = close − EMA(close, period)', () => {
    const e = ema(C, 14);
    const oracle = e.map((ev, i) => (live(ev) ? C[i]! - ev : null));
    same(ta.dsp(C, { period: 14 }), oracle, 'dsp');
  });

  it('vwap = cumΣ(typical·volume) / cumΣ(volume)', () => {
    const oracle: Num[] = [];
    let pv = 0;
    let vv = 0;
    for (let i = 0; i < C.length; i++) {
      pv += typical[i]! * V[i]!;
      vv += V[i]!;
      oracle.push(vv === 0 ? null : pv / vv);
    }
    same(ta.vwap(bars, {}), oracle, 'vwap');
  });

  it('rainbowMovingAverage = mean of a 10-deep recursive SMA cascade', () => {
    const period = 2;
    const levels = 10;
    // simulate the chained SMAs exactly: each level's SMA is fed the previous level's output, and a
    // level only emits once it has `period` live inputs (mirrors the streaming short-circuit).
    const bufs: number[][] = Array.from({ length: levels }, () => []);
    const oracle = C.map((c) => {
      let cur: number | null = c;
      let sum = 0;
      for (let lvl = 0; lvl < levels; lvl++) {
        if (cur === null) return null;
        bufs[lvl]!.push(cur);
        if (bufs[lvl]!.length > period) bufs[lvl]!.shift();
        if (bufs[lvl]!.length < period) return null;
        cur = bufs[lvl]!.reduce((a, b) => a + b, 0) / period;
        sum += cur;
      }
      return sum / levels;
    });
    same(ta.rainbowMovingAverage(C, { period, levels }), oracle, 'rainbowMovingAverage');
  });

  it('movingAverageRibbon level k = SMA(close, periods[k])', () => {
    const periods = [10, 20, 30];
    const o = ta.movingAverageRibbon(C, { periods });
    periods.forEach((p, k) => same(col(o, String(k)), sma(C, p), `movingAverageRibbon[${k}]`));
  });

  it('vidya = α·|CMO|·price + (1 − α·|CMO|)·prev (TradingView VIDYA)', () => {
    const period = 14;
    const cmoPeriod = 9;
    const alpha = 2 / (period + 1);
    const ups: number[] = [];
    const downs: number[] = [];
    let sumUp = 0;
    let sumDown = 0;
    let prev: number | null = null;
    let vidya: number | null = null;
    const oracle: Num[] = [];
    for (let i = 0; i < C.length; i++) {
      const v = C[i]!;
      if (prev === null) {
        prev = v;
        oracle.push(null);
        continue;
      }
      const ch = v - prev;
      prev = v;
      ups.push(ch > 0 ? ch : 0);
      downs.push(ch < 0 ? -ch : 0);
      sumUp += ups[ups.length - 1]!;
      sumDown += downs[downs.length - 1]!;
      if (ups.length > cmoPeriod) {
        sumUp -= ups.shift()!;
        sumDown -= downs.shift()!;
      }
      if (ups.length < cmoPeriod) {
        oracle.push(null);
        continue;
      }
      const denom = sumUp + sumDown;
      const k = denom === 0 ? 0 : Math.abs(sumUp - sumDown) / denom;
      const a = alpha * k;
      if (vidya === null) vidya = v;
      vidya = a * v + (1 - a) * vidya;
      oracle.push(vidya);
    }
    same(ta.vidya(C, { period, cmoPeriod }), oracle, 'vidya');
  });

  it('linearDecay = max(close, previousClose − 1/period); exponentialDecay uses exp(−period)', () => {
    const ld = C.map((c, i) => (i === 0 ? c : Math.max(c, C[i - 1]! - 1 / 5)));
    same(ta.linearDecay(C, { period: 5 }), ld, 'linearDecay');
    const step = Math.exp(-5);
    const ed = C.map((c, i) => (i === 0 ? c : Math.max(c, C[i - 1]! - step)));
    same(ta.exponentialDecay(C, { period: 5 }), ed, 'exponentialDecay');
  });
});

describe('closed-form oracles — momentum', () => {
  it('centerOfGravity = Ehlers CG: −Σ(1+i)·p[i] / Σp[i] + (n+1)/2', () => {
    const n = 10;
    const oracle = C.map((_, i) => {
      if (i < n - 1) return null;
      let num = 0;
      let den = 0;
      for (let k = 0; k < n; k++) {
        const price = C[i - k]!;
        num += (1 + k) * price;
        den += price;
      }
      return den === 0 ? 0 : -num / den + (n + 1) / 2;
    });
    same(ta.centerOfGravity(C, { period: n }), oracle, 'centerOfGravity');
  });

  it('cfo = 100·(close − LINREG(close, period)) / close', () => {
    const lr = linregEndpoint(C, 14);
    const oracle = lr.map((v, i) => (live(v) && C[i]! !== 0 ? (100 * (C[i]! - v)) / C[i]! : null));
    same(ta.cfo(C, { period: 14 }), oracle, 'cfo', 1e-7, 1e-8);
  });

  it('trixHistogram = TRIX − EMA(TRIX, signal)', () => {
    const trix = trixS(C, 18);
    const signal = emaSparse(trix, 9);
    const o = ta.trixHistogram(C, { period: 18, signal: 9 });
    same(col(o, 'trix'), trix, 'trixHistogram.trix');
    same(col(o, 'signal'), signal, 'trixHistogram.signal');
    same(
      col(o, 'histogram'),
      trix.map((t, i) => (live(t) && live(signal[i]) ? t - signal[i]! : null)),
      'trixHistogram.histogram',
    );
  });

  it('dpo = close[i − (⌊p/2⌋+1)] − SMA(close, p)[i] (classic Pring)', () => {
    const p = 20;
    const shift = Math.floor(p / 2) + 1;
    const s = sma(C, p);
    const oracle = s.map((sv, i) => (live(sv) && i - shift >= 0 ? C[i - shift]! - sv : null));
    same(ta.dpo(C, { period: p }), oracle, 'dpo');
  });

  it('laguerreRsi = Ehlers 4-stage Laguerre filter ratio', () => {
    const g = 0.5;
    let l0: number | null = null;
    let l1 = 0;
    let l2 = 0;
    let l3 = 0;
    const oracle: Num[] = [];
    for (const price of C) {
      if (l0 === null) {
        l0 = l1 = l2 = l3 = price;
        oracle.push(0);
        continue;
      }
      const n0: number = (1 - g) * price + g * l0;
      const n1: number = -g * n0 + l0 + g * l1;
      const n2: number = -g * n1 + l1 + g * l2;
      const n3: number = -g * n2 + l2 + g * l3;
      let cu = 0;
      let cd = 0;
      if (n0 >= n1) cu += n0 - n1;
      else cd += n1 - n0;
      if (n1 >= n2) cu += n1 - n2;
      else cd += n2 - n1;
      if (n2 >= n3) cu += n2 - n3;
      else cd += n3 - n2;
      l0 = n0;
      l1 = n1;
      l2 = n2;
      l3 = n3;
      oracle.push(cu + cd === 0 ? 0 : cu / (cu + cd));
    }
    same(ta.laguerreRsi(C, { gamma: g }), oracle, 'laguerreRsi');
  });

  it('fisherTransform = Ehlers Fisher of normalized (H+L)/2', () => {
    const period = 9;
    let valv = 0;
    let fish = 0;
    const fisher: Num[] = [];
    const trigger: Num[] = [];
    for (let i = 0; i < bars.length; i++) {
      if (i < period - 1) {
        fisher.push(null);
        trigger.push(null);
        continue;
      }
      let hh = -Infinity;
      let ll = Infinity;
      for (let k = i - period + 1; k <= i; k++) {
        hh = Math.max(hh, H[k]!);
        ll = Math.min(ll, L[k]!);
      }
      const price = (H[i]! + L[i]!) / 2;
      const raw = hh === ll ? 0 : ((price - ll) / (hh - ll) - 0.5) * 2;
      valv = 0.33 * raw + 0.67 * valv;
      let v = valv;
      if (v > 0.999) v = 0.999;
      if (v < -0.999) v = -0.999;
      const prevFish = fish;
      fish = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * prevFish;
      fisher.push(fish);
      trigger.push(prevFish);
    }
    const o = ta.fisherTransform(bars, { period });
    same(col(o, 'fisher'), fisher, 'fisherTransform.fisher');
    same(col(o, 'trigger'), trigger, 'fisherTransform.trigger');
  });
});

describe('closed-form oracles — trend / signals', () => {
  it('trendSignals: trend = value > 0; entry/exit on flips', () => {
    const src = ta.macd(C, { fast: 12, slow: 26, signal: 9 }).map((m) => (m ? m.histogram : null));
    const o = ta.trendSignals(src as number[], {});
    let prevTrend = 0;
    const trend: Num[] = [];
    const entry: Num[] = [];
    const exit: Num[] = [];
    for (const v of src) {
      const t = live(v) && v > 0 ? 1 : 0;
      trend.push(t);
      entry.push(t === 1 && prevTrend === 0 ? 1 : 0);
      exit.push(t === 0 && prevTrend === 1 ? 1 : 0);
      prevTrend = t;
    }
    same(col(o, 'trend'), trend, 'trendSignals.trend', 0, 0);
    same(col(o, 'entry'), entry, 'trendSignals.entry', 0, 0);
    same(col(o, 'exit'), exit, 'trendSignals.exit', 0, 0);
  });

  it('crossSignals: long on cross-up through `above`, flat on cross-down through `below`', () => {
    const rsi = ta.rsi(C, { period: 14 });
    const above = 70;
    const below = 30;
    const o = ta.crossSignals(rsi as number[], { above, below });
    let prev: number | null = null;
    let pos = 0;
    const trend: Num[] = [];
    const entry: Num[] = [];
    const exit: Num[] = [];
    for (const v of rsi) {
      if (prev === null || !live(v)) {
        if (live(v)) prev = v;
        trend.push(null);
        entry.push(null);
        exit.push(null);
        continue;
      }
      const crossUp = prev <= above && v > above;
      const crossDown = prev >= below && v < below;
      let e = 0;
      let x = 0;
      if (pos === 0 && crossUp) {
        pos = 1;
        e = 1;
      } else if (pos === 1 && crossDown) {
        pos = 0;
        x = 1;
      }
      prev = v;
      trend.push(pos);
      entry.push(e);
      exit.push(x);
    }
    same(col(o, 'trend'), trend, 'crossSignals.trend', 0, 0);
    same(col(o, 'entry'), entry, 'crossSignals.entry', 0, 0);
    same(col(o, 'exit'), exit, 'crossSignals.exit', 0, 0);
  });
});

describe('closed-form oracles — statistics / MACD variants', () => {
  it('beta = financial beta on returns: covariance(Δx, Δy) / valueAtRisk(Δy) over the window', () => {
    const x = C;
    const y = H;
    const period = 20;
    const pairInput = x.map((v, i) => ({ x: v, y: y[i]! }));
    // returns, matching the stream (skips the first bar; window of `period` returns)
    const rx: number[] = [];
    const ry: number[] = [];
    for (let i = 1; i < x.length; i++) {
      rx.push((x[i]! - x[i - 1]!) / x[i - 1]!);
      ry.push((y[i]! - y[i - 1]!) / y[i - 1]!);
    }
    const oracle: Num[] = [null]; // bar 0 has no return
    for (let r = 0; r < rx.length; r++) {
      if (r < period - 1) {
        oracle.push(null);
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let syy = 0;
      for (let k = r - period + 1; k <= r; k++) {
        sx += rx[k]!;
        sy += ry[k]!;
        sxy += rx[k]! * ry[k]!;
        syy += ry[k]! * ry[k]!;
      }
      const covariance = sxy / period - (sx / period) * (sy / period);
      const varY = syy / period - (sy / period) ** 2;
      oracle.push(varY === 0 ? 0 : covariance / varY);
    }
    same(ta.beta(pairInput, { period }), oracle, 'beta', 1e-7, 1e-8);
  });

  it('macdFix = standard EMA(12) − EMA(26), signal EMA(9)', () => {
    const fast = ema(C, 12);
    const slow = ema(C, 26);
    const line = fast.map((f, i) => (live(f) && live(slow[i]) ? f - slow[i]! : null));
    const signal = emaSparse(line, 9);
    const o = ta.macdFix(C, { signal: 9 });
    same(col(o, 'macd'), line, 'macdFix.macd');
    same(col(o, 'signal'), signal, 'macdFix.signal');
  });

  it('macdExt (EMA matypes) = EMA(fast) − EMA(slow), signal EMA', () => {
    const fast = ema(C, 12);
    const slow = ema(C, 26);
    const line = fast.map((f, i) => (live(f) && live(slow[i]) ? f - slow[i]! : null));
    const signal = emaSparse(line, 9);
    const o = ta.macdExt(C, {
      fast: 12,
      slow: 26,
      signal: 9,
      fastMovingAverageType: 'ema',
      slowMovingAverageType: 'ema',
      signalMovingAverageType: 'ema',
    });
    same(col(o, 'macd'), line, 'macdExt.macd');
    same(col(o, 'signal'), signal, 'macdExt.signal');
  });
});

describe('closed-form oracles — batch 2 (stateful, standard formulas)', () => {
  it('pgo = (close − SMA(close, p)) / EMA(trueRange, p)', () => {
    const p = 14;
    const tr = ta.trueRange(bars, {});
    const atr = ema(tr, p);
    const m = sma(C, p);
    const oracle = C.map((c, i) =>
      live(m[i]) && live(atr[i]) && atr[i]! !== 0 ? (c - m[i]!) / atr[i]! : null,
    );
    same(ta.pgo(bars, { period: p }), oracle, 'pgo');
  });

  it('relativeVolatilityIndex = 100·RMA(up) / (RMA(up)+RMA(down)), up/down gated by sample STDDEV', () => {
    const period = 14;
    const stdevPeriod = 14;
    const sd = stddevS(C, stdevPeriod, true);
    const up: Num[] = [];
    const down: Num[] = [];
    for (let i = 0; i < C.length; i++) {
      if (i === 0 || !live(sd[i])) {
        up.push(null);
        down.push(null);
        continue;
      }
      const s = sd[i]!;
      up.push(C[i]! > C[i - 1]! ? s : 0);
      down.push(C[i]! < C[i - 1]! ? s : 0);
    }
    const pa = rmaSparse(up, period);
    const levelSmoothing = rmaSparse(down, period);
    const oracle = pa.map((p2, i) =>
      live(p2) && live(levelSmoothing[i])
        ? p2 + levelSmoothing[i]! === 0
          ? 0
          : (100 * p2) / (p2 + levelSmoothing[i]!)
        : null,
    );
    same(ta.relativeVolatilityIndex(C, { period, stdevPeriod }), oracle, 'relativeVolatilityIndex');
  });

  it('klinger = EMA(VF,fast) − EMA(VF,slow); VF is the Klinger volume force', () => {
    const vf: Num[] = [null];
    let prevHlc = H[0]! + L[0]! + C[0]!;
    let prevTrend = 1;
    let prevDm = H[0]! - L[0]!;
    let prevCm = H[0]! - L[0]!;
    for (let i = 1; i < bars.length; i++) {
      const hlc = H[i]! + L[i]! + C[i]!;
      const dm = H[i]! - L[i]!;
      const trend = hlc >= prevHlc ? 1 : -1;
      const cm = trend === prevTrend ? prevCm + dm : prevDm + dm;
      vf.push(cm === 0 ? 0 : V[i]! * Math.abs(2 * (dm / cm) - 1) * trend * 100);
      prevHlc = hlc;
      prevTrend = trend;
      prevDm = dm;
      prevCm = cm;
    }
    const fast = emaSparse(vf, 34);
    const slow = emaSparse(vf, 55);
    const kvo = fast.map((f, i) => (live(f) && live(slow[i]) ? f - slow[i]! : null));
    const signal = emaSparse(kvo, 13);
    const o = ta.klinger(bars, { fast: 34, slow: 55, signal: 13 });
    same(col(o, 'klinger'), kvo, 'klinger.klinger');
    same(col(o, 'signal'), signal, 'klinger.signal');
  });

  it('entropy = Σ −p·log₂(p) over the window, p = value / Σ window (windowed Shannon)', () => {
    const period = 10;
    const oracle = C.map((_, i) => {
      if (i < period - 1) return null;
      let total = 0;
      for (let k = i - period + 1; k <= i; k++) total += C[k]!;
      if (total <= 0) return null;
      let e = 0;
      for (let k = i - period + 1; k <= i; k++) {
        const pr = C[k]! / total;
        if (pr > 0) e += -pr * Math.log2(pr);
      }
      return e;
    });
    same(ta.entropy(C, { period }), oracle, 'entropy');
  });

  it('emv is identical to easeOfMovement (the certified pandas-ta `eom`)', () => {
    same(
      ta.emv(bars, { period: 14 }) as Series,
      ta.easeOfMovement(bars, { period: 14 }) as Series,
      'emv≡easeOfMovement',
      0,
      0,
    );
  });

  it('chandelierExit long/short = highestHigh − k·ATR / lowestLow + k·ATR', () => {
    const period = 22;
    const mult = 3;
    const atr = ta.atr(bars, { period });
    const oracle = (side: 'long' | 'short'): Series =>
      bars.map((_, i) => {
        if (i < period - 1 || !live(atr[i])) return null;
        let hh = -Infinity;
        let ll = Infinity;
        for (let k = i - period + 1; k <= i; k++) {
          hh = Math.max(hh, H[k]!);
          ll = Math.min(ll, L[k]!);
        }
        return side === 'long' ? hh - mult * atr[i]! : ll + mult * atr[i]!;
      });
    const o = ta.chandelierExit(bars, { period, multiplier: mult });
    same(col(o, 'long'), oracle('long'), 'chandelierExit.long');
    same(col(o, 'short'), oracle('short'), 'chandelierExit.short');
  });

  it('gannHighLowActivator: trend flips on close vs prior SMA(high)/SMA(low); line follows', () => {
    const period = 13;
    const sh = sma(H, period);
    const sl = sma(L, period);
    let prevSmaHigh: number | null = null;
    let prevSmaLow = 0;
    let trend = 1;
    const value: Num[] = [];
    const tr: Num[] = [];
    for (let i = 0; i < bars.length; i++) {
      if (!live(sh[i]) || !live(sl[i])) {
        value.push(null);
        tr.push(null);
        continue;
      }
      if (prevSmaHigh !== null) {
        if (C[i]! > prevSmaHigh) trend = 1;
        else if (C[i]! < prevSmaLow) trend = -1;
      }
      prevSmaHigh = sh[i]!;
      prevSmaLow = sl[i]!;
      value.push(trend === 1 ? sl[i]! : sh[i]!);
      tr.push(trend);
    }
    const o = ta.gannHighLowActivator(bars, { period });
    same(col(o, 'value'), value, 'gannHilo.value');
    same(col(o, 'trend'), tr, 'gannHilo.trend', 0, 0);
  });

  it('longRun / shortRun = both MAs rising / falling over the lookback', () => {
    const period = 2;
    const fast = ema(C, 8);
    const slow = ema(C, 21);
    const pair = C.map((_, i) => ({ x: fast[i] ?? NaN, y: slow[i] ?? NaN }));
    const run = (up: boolean): Series =>
      C.map((_, i) => {
        if (
          i < period ||
          !live(fast[i]) ||
          !live(fast[i - period]) ||
          !live(slow[i]) ||
          !live(slow[i - period])
        )
          return null;
        const xMove = up ? fast[i]! > fast[i - period]! : fast[i]! < fast[i - period]!;
        const yMove = up ? slow[i]! > slow[i - period]! : slow[i]! < slow[i - period]!;
        return xMove && yMove ? 1 : 0;
      });
    same(ta.longRun(pair, { period }), run(true), 'longRun', 0, 0, 25);
    same(ta.shortRun(pair, { period }), run(false), 'shortRun', 0, 0, 25);
  });
});

describe('closed-form oracles — batch 3 (regression-based)', () => {
  it('inertia = LINREG endpoint of the (close-based) Relative Volatility Index', () => {
    const period = 20;
    const rviPeriod = 14;
    const rvi = ta.relativeVolatilityIndex(C, { period: rviPeriod, stdevPeriod: rviPeriod });
    const oracle = linregEndpointSparse(rvi, period);
    same(ta.inertia(C, { period, rviPeriod }), oracle, 'inertia', 1e-7, 1e-8);
  });

  it('schaffTrendCycle = double-smoothed stochastic of MACD (Schaff)', () => {
    const fast = 23;
    const slow = 50;
    const cycle = 10;
    const ef = ema(C, fast);
    const es = ema(C, slow);
    const macd: Num[] = ef.map((f, i) => (live(f) && live(es[i]) ? f - es[i]! : null));
    const stoch = (buf: number[], cur: number, prev: number | null): number => {
      let lo = buf[0]!;
      let hi = buf[0]!;
      for (const x of buf) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      return hi === lo ? (prev ?? 0) : (100 * (cur - lo)) / (hi - lo);
    };
    const macdBuf: number[] = [];
    const d1Buf: number[] = [];
    let d1: number | null = null;
    let d2: number | null = null;
    const oracle: Num[] = [];
    for (let i = 0; i < C.length; i++) {
      const m = macd[i];
      if (!live(m)) {
        oracle.push(null);
        continue;
      }
      macdBuf.push(m);
      if (macdBuf.length > cycle) macdBuf.shift();
      if (macdBuf.length < cycle) {
        oracle.push(null);
        continue;
      }
      const s1 = stoch(macdBuf, m, d1);
      d1 = d1 === null ? s1 : d1 + 0.5 * (s1 - d1);
      d1Buf.push(d1);
      if (d1Buf.length > cycle) d1Buf.shift();
      if (d1Buf.length < cycle) {
        oracle.push(null);
        continue;
      }
      const s2 = stoch(d1Buf, d1, d2);
      d2 = d2 === null ? s2 : d2 + 0.5 * (s2 - d2);
      oracle.push(Math.max(0, Math.min(100, d2)));
    }
    same(ta.schaffTrendCycle(C, { fast, slow, cycle }), oracle, 'schaffTrendCycle');
  });

  it('projectionOscillator = 100·(close − projLow) / (projHigh − projLow) along the regression slope', () => {
    const period = 14;
    const slope = linregSlope(C, period);
    const po: Num[] = [];
    const upper: Num[] = [];
    const lower: Num[] = [];
    for (let i = 0; i < bars.length; i++) {
      if (i < period - 1 || !live(slope[i])) {
        po.push(null);
        upper.push(null);
        lower.push(null);
        continue;
      }
      let pu = -Infinity;
      let pl = Infinity;
      for (let k = 0; k < period; k++) {
        const hi = H[i - k]! + slope[i]! * k;
        const lo = L[i - k]! + slope[i]! * k;
        if (hi > pu) pu = hi;
        if (lo < pl) pl = lo;
      }
      upper.push(pu);
      lower.push(pl);
      po.push(pu === pl ? 50 : (100 * (C[i]! - pl)) / (pu - pl));
    }
    const o = ta.projectionOscillator(bars, { period });
    same(col(o, 'po'), po, 'projectionOscillator.po', 1e-7, 1e-8);
    same(col(o, 'upper'), upper, 'projectionOscillator.upper', 1e-7, 1e-8);
    same(col(o, 'lower'), lower, 'projectionOscillator.lower', 1e-7, 1e-8);
  });

  it('pMax = Supertrend-style ATR trail on an EMA basis (pmax / trend)', () => {
    const period = 10;
    const mult = 3;
    const ma = ema(C, period);
    const atr = ta.atr(bars, { period });
    let started = false;
    let longStop = 0;
    let shortStop = 0;
    let dir = 1;
    let prevMa: number | null = null;
    const pmax: Num[] = [];
    const trend: Num[] = [];
    for (let i = 0; i < bars.length; i++) {
      if (!live(ma[i]) || !live(atr[i])) {
        pmax.push(null);
        trend.push(null);
        continue;
      }
      const m = ma[i]!;
      const a = atr[i]!;
      if (!started) {
        longStop = m - mult * a;
        shortStop = m + mult * a;
        dir = C[i]! >= m ? 1 : -1;
        prevMa = m;
        started = true;
      } else {
        let ls = m - mult * a;
        if (prevMa! > longStop) ls = Math.max(ls, longStop);
        let ss = m + mult * a;
        if (prevMa! < shortStop) ss = Math.min(ss, shortStop);
        if (dir === 1 && m < longStop) dir = -1;
        else if (dir === -1 && m > shortStop) dir = 1;
        longStop = ls;
        shortStop = ss;
        prevMa = m;
      }
      pmax.push(dir === 1 ? longStop : shortStop);
      trend.push(dir);
    }
    const o = ta.pMax(bars, { period, multiplier: mult });
    same(col(o, 'pmax'), pmax, 'pMax.pmax');
    same(col(o, 'trend'), trend, 'pMax.trend', 0, 0);
  });
});

// ── batch 4: chosen-formula oracles for the previously name-only proprietary/convention indicators.
// Each recomputes the *published* formula TotalFinance implements (public Jurik JMA, Katsanos VFI, LazyBear
// squeeze, standard DeMark TD Sequential) — the variant must be chosen before "proof" means anything,
// per the completeness review — and asserts TotalFinance reproduces that chosen reference exactly.
const popStdev = (a: number[]): number => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const sampleStdev = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

describe('closed-form oracles — batch 4 (chosen public-formula oracles)', () => {
  it('jma = the public Jurik recurrence (e0/e1/e2 adaptive double-smoother)', () => {
    const period = 10;
    const phase = 0;
    const power = 1;
    const beta = (0.45 * (period - 1)) / (0.45 * (period - 1) + 2);
    const alpha = Math.pow(beta, power);
    const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
    let e0 = 0;
    let e1 = 0;
    let e2 = 0;
    let jma = 0;
    const oracle = C.map((src) => {
      e0 = (1 - alpha) * src + alpha * e0;
      e1 = (src - e0) * (1 - beta) + beta * e1;
      e2 = (e0 + phaseRatio * e1 - jma) * (1 - alpha) ** 2 + alpha ** 2 * e2;
      jma = e2 + jma;
      return jma;
    });
    same(ta.jma(C, { period, phase, power }), oracle, 'jma');
  });

  it('vfi = Katsanos Volume Flow Indicator (capped signed money flow, EMA-smoothed)', () => {
    const period = 130;
    const coefficient = 0.2;
    const volumeCutoff = 2.5;
    const smooth = 3;
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    const raw: Num[] = [];
    const volumeBuffer: number[] = [];
    let volumeSum = 0;
    const inter: number[] = [];
    const vcp: number[] = [];
    let prevTp: number | null = null;
    for (let i = 0; i < bars.length; i++) {
      const v = V[i]!;
      volumeBuffer.push(v);
      volumeSum += v;
      if (volumeBuffer.length > period) volumeSum -= volumeBuffer.shift()!;
      if (prevTp === null || prevTp <= 0 || tp[i]! <= 0) {
        prevTp = tp[i]!;
        raw.push(null);
        continue;
      }
      inter.push(Math.log(tp[i]!) - Math.log(prevTp));
      if (inter.length > 30) inter.shift();
      const vave = volumeSum / volumeBuffer.length;
      const vc = Math.min(v, vave * volumeCutoff);
      const cutoff = inter.length >= 2 ? coefficient * sampleStdev(inter) * bars[i]!.close : 0;
      const mf = tp[i]! - prevTp;
      prevTp = tp[i]!;
      vcp.push(mf > cutoff ? vc : mf < -cutoff ? -vc : 0);
      if (vcp.length > period) vcp.shift();
      raw.push(vcp.length < period || vave === 0 ? null : vcp.reduce((s, x) => s + x, 0) / vave);
    }
    const oracle = emaSparse(raw, smooth);
    same(ta.vfi(bars, { period, coefficient, volumeCutoff, smooth }), oracle, 'vfi');
  });

  it('squeezePro momentum + low/mid/high flags = the LazyBear BB-in-KC squeeze', () => {
    const bollingerBandPeriod = 20;
    const bollingerStandardDeviations = 2;
    const keltnerChannelPeriod = 20;
    const [
      wideKeltnerChannelMultiplier,
      normalKeltnerChannelMultiplier,
      narrowKeltnerChannelMultiplier,
    ] = [2, 1.5, 1];
    const closes: number[] = [];
    const trs: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const linBuf: number[] = [];
    let previousClose: number | null = null;
    const momentum: Num[] = [];
    const low: Num[] = [];
    const mid: Num[] = [];
    const high: Num[] = [];
    const smaOf = (a: number[], p: number): number => a.slice(-p).reduce((s, x) => s + x, 0) / p;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const tr =
        previousClose === null
          ? b.high - b.low
          : Math.max(
              b.high - b.low,
              Math.abs(b.high - previousClose),
              Math.abs(b.low - previousClose),
            );
      previousClose = b.close;
      closes.push(b.close);
      trs.push(tr);
      highs.push(b.high);
      lows.push(b.low);
      const warm = closes.length >= keltnerChannelPeriod && closes.length >= bollingerBandPeriod;
      if (!warm) {
        momentum.push(null);
        low.push(null);
        mid.push(null);
        high.push(null);
        continue;
      }
      const keltnerChannelMiddle = smaOf(closes, keltnerChannelPeriod);
      const keltnerChannelRange = smaOf(trs, keltnerChannelPeriod);
      const bbMid = smaOf(closes, bollingerBandPeriod);
      const hh = Math.max(...highs.slice(-keltnerChannelPeriod));
      const ll = Math.min(...lows.slice(-keltnerChannelPeriod));
      const mm = ((hh + ll) / 2 + keltnerChannelMiddle) / 2;
      linBuf.push(b.close - mm);
      if (linBuf.length > keltnerChannelPeriod) linBuf.shift();
      const dev = bollingerStandardDeviations * popStdev(closes.slice(-bollingerBandPeriod));
      const upperBollingerBand = bbMid + dev;
      const lowerBollingerBand = bbMid - dev;
      if (linBuf.length < keltnerChannelPeriod) {
        momentum.push(null);
        low.push(null);
        mid.push(null);
        high.push(null);
        continue;
      }
      momentum.push(linregEndpoint(linBuf, keltnerChannelPeriod)[keltnerChannelPeriod - 1]!);
      const inside = (m: number): number =>
        lowerBollingerBand > keltnerChannelMiddle - m * keltnerChannelRange &&
        upperBollingerBand < keltnerChannelMiddle + m * keltnerChannelRange
          ? 1
          : 0;
      low.push(inside(wideKeltnerChannelMultiplier));
      mid.push(inside(normalKeltnerChannelMultiplier));
      high.push(inside(narrowKeltnerChannelMultiplier));
    }
    const o = ta.squeezePro(bars, {
      bollingerBandPeriod,
      bollingerStandardDeviations,
      keltnerChannelPeriod,
      wideKeltnerChannelMultiplier,
      normalKeltnerChannelMultiplier,
      narrowKeltnerChannelMultiplier,
    });
    same(col(o, 'momentum'), momentum, 'squeezePro.momentum', 1e-7, 1e-8);
    same(col(o, 'lowCompression'), low, 'squeezePro.lowCompression', 0, 0);
    same(col(o, 'normalCompression'), mid, 'squeezePro.normalCompression', 0, 0);
    same(col(o, 'highCompression'), high, 'squeezePro.highCompression', 0, 0);
  });

  it('tdSequential = standard DeMark setup (1–9) + countdown (1–13)', () => {
    const lookback = 4;
    const cl: number[] = [];
    const recent: BarLike[] = [];
    let buySetup = 0;
    let sellSetup = 0;
    let armed = 0;
    let countdown = 0;
    const setupArr: Num[] = [];
    const cdArr: Num[] = [];
    const dirArr: Num[] = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      cl.push(b.close);
      if (cl.length > lookback + 1) cl.shift();
      recent.push({ high: b.high, low: b.low });
      if (recent.length > 3) recent.shift();
      if (cl.length < lookback + 1) {
        setupArr.push(null);
        cdArr.push(null);
        dirArr.push(null);
        continue;
      }
      const ref = cl[0]!;
      let setup = 0;
      let direction = 0;
      if (b.close < ref) {
        const was = buySetup;
        buySetup = Math.min(buySetup + 1, 9);
        sellSetup = 0;
        if (was === 8 && buySetup === 9) {
          armed = -1;
          countdown = 0;
        }
        setup = buySetup;
        direction = -1;
      } else if (b.close > ref) {
        const was = sellSetup;
        sellSetup = Math.min(sellSetup + 1, 9);
        buySetup = 0;
        if (was === 8 && sellSetup === 9) {
          armed = 1;
          countdown = 0;
        }
        setup = sellSetup;
        direction = 1;
      } else {
        buySetup = 0;
        sellSetup = 0;
      }
      if (armed !== 0 && recent.length === 3) {
        const ago2 = recent[0]!;
        if (armed === -1 && b.close <= ago2.low && countdown < 13) countdown++;
        else if (armed === 1 && b.close >= ago2.high && countdown < 13) countdown++;
        if (countdown >= 13) armed = 0;
      }
      setupArr.push(setup);
      cdArr.push(countdown);
      dirArr.push(direction);
    }
    const o = ta.tdSequential(bars, { lookback });
    same(col(o, 'setup'), setupArr, 'tdSequential.setup', 0, 0);
    same(col(o, 'countdown'), cdArr, 'tdSequential.countdown', 0, 0);
    same(col(o, 'direction'), dirArr, 'tdSequential.direction', 0, 0);
  });
});

interface BarLike {
  high: number;
  low: number;
}
