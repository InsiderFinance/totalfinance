import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

/**
 * Golden-vector tests: each indicator is cross-checked against an INDEPENDENT, from-scratch textbook
 * oracle written in this file (no shared code with the implementation) over a fixed reference series,
 * at full-series precision. The oracle is the "independent source" — it encodes the canonical TA-Lib
 * definition naively, so any divergence between it and the optimized streaming code surfaces here.
 *
 * Only indicators with an unambiguous canonical definition are covered; the rest rely on closed-form
 * and batch≡stream parity tests in the per-family suites.
 */

// ── fixed reference data (deterministic; computed input, oracle-checked output) ──
const N = 64;
const prices = Array.from(
  { length: N },
  (_, i) => 100 + 10 * Math.sin(i / 4) + i * 0.2 + (i % 5 === 0 ? 2 : -1),
);
const bars: BarInput[] = prices.map((c, i) => {
  const open = i === 0 ? c : prices[i - 1]!;
  const high = Math.max(open, c) + 1 + (i % 3) * 0.5;
  const low = Math.min(open, c) - 1 - (i % 4) * 0.3;
  return { open, high, low, close: c, volume: 1000 + ((i * 53) % 400) };
});
const PREC = 8;

// ── independent oracles ─────────────────────────────────────────────────────
const filled = (n: number): number[] => Array.from({ length: n }, () => NaN);
function smaArr(x: number[], n: number): number[] {
  const out = filled(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += x[j]!;
    out[i] = s / n;
  }
  return out;
}
function emaArr(x: number[], n: number): number[] {
  const out = filled(x.length);
  if (x.length < n) return out;
  let seed = 0;
  for (let j = 0; j < n; j++) seed += x[j]!;
  let e = seed / n; // SMA-seed at index n−1
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < x.length; i++) {
    e = (x[i]! - e) * k + e;
    out[i] = e;
  }
  return out;
}
/** EMA applied to a series that has leading NaNs (e.g. the output of another EMA). */
function emaOfNanArr(x: number[], n: number): number[] {
  const first = x.findIndex((v) => !Number.isNaN(v));
  if (first < 0) return filled(x.length);
  const tail = x.slice(first);
  const e = emaArr(tail, n);
  const out = filled(x.length);
  for (let j = 0; j < e.length; j++) out[first + j] = e[j]!;
  return out;
}
function wmaArr(x: number[], n: number): number[] {
  const out = filled(x.length);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let num = 0;
    for (let j = 0; j < n; j++) num += x[i - n + 1 + j]! * (j + 1);
    out[i] = num / denom;
  }
  return out;
}
function rmaArr(x: number[], n: number): number[] {
  const out = filled(x.length);
  if (x.length < n) return out;
  let seed = 0;
  for (let j = 0; j < n; j++) seed += x[j]!;
  let r = seed / n;
  out[n - 1] = r;
  for (let i = n; i < x.length; i++) {
    r = (r * (n - 1) + x[i]!) / n;
    out[i] = r;
  }
  return out;
}
function rollMax(x: number[], n: number): number[] {
  const out = filled(x.length);
  for (let i = n - 1; i < x.length; i++) out[i] = Math.max(...x.slice(i - n + 1, i + 1));
  return out;
}
function rollMin(x: number[], n: number): number[] {
  const out = filled(x.length);
  for (let i = n - 1; i < x.length; i++) out[i] = Math.min(...x.slice(i - n + 1, i + 1));
  return out;
}
function rollSum(x: number[], n: number): number[] {
  const out = filled(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += x[j]!;
    out[i] = s;
  }
  return out;
}

const closes = bars.map((b) => b.close);
const highs = bars.map((b) => b.high);
const lows = bars.map((b) => b.low);

/** Assert an aligned indicator output matches the oracle: NaN where the oracle warms up, else close. */
function expectSeries(actual: readonly (number | null)[], oracle: number[], label: string): void {
  expect(actual.length, `${label} length`).toBe(oracle.length);
  for (let i = 0; i < oracle.length; i++) {
    const a = actual[i];
    if (Number.isNaN(oracle[i]!)) {
      expect(a === null || Number.isNaN(a as number), `${label}[${i}] warmup`).toBe(true);
    } else {
      expect(a as number, `${label}[${i}]`).toBeCloseTo(oracle[i]!, PREC);
    }
  }
}

// ── moving averages ─────────────────────────────────────────────────────────
describe('golden vectors — moving averages', () => {
  it('sma / ema / wma / rma match textbook oracles', () => {
    for (const n of [5, 10, 20]) {
      expectSeries(ta.sma(closes, { period: n }), smaArr(closes, n), `sma${n}`);
      expectSeries(ta.ema(closes, { period: n }), emaArr(closes, n), `ema${n}`);
      expectSeries(ta.wma(closes, { period: n }), wmaArr(closes, n), `wma${n}`);
      expectSeries(ta.rma(closes, { period: n }), rmaArr(closes, n), `rma${n}`);
    }
  });
  it('dema / tema match the EMA-cascade definitions', () => {
    const n = 10;
    const e1 = emaArr(closes, n);
    const e2 = emaOfNanArr(e1, n);
    const e3 = emaOfNanArr(e2, n);
    const dema = e1.map((v, i) => 2 * v - e2[i]!);
    const tema = e1.map((v, i) => 3 * v - 3 * e2[i]! + e3[i]!);
    expectSeries(ta.dema(closes, { period: n }), dema, 'dema');
    expectSeries(ta.tema(closes, { period: n }), tema, 'tema');
  });
  it('midpoint / midprice', () => {
    const n = 14;
    const mid = closes.map((_, i) =>
      i < n - 1 ? NaN : (rollMax(closes, n)[i]! + rollMin(closes, n)[i]!) / 2,
    );
    expectSeries(ta.midpoint(closes, { period: n }), mid, 'midpoint');
    const midp = closes.map((_, i) =>
      i < n - 1 ? NaN : (rollMax(highs, n)[i]! + rollMin(lows, n)[i]!) / 2,
    );
    expectSeries(ta.midprice(bars, { period: n }), midp, 'midprice');
  });
});

// ── transforms ──────────────────────────────────────────────────────────────
describe('golden vectors — transforms', () => {
  it('price transforms and true range', () => {
    expectSeries(
      ta.typicalPrice(bars, {}),
      bars.map((b) => (b.high + b.low + b.close) / 3),
      'typicalPrice',
    );
    expectSeries(
      ta.medianPrice(bars, {}),
      bars.map((b) => (b.high + b.low) / 2),
      'medianPrice',
    );
    expectSeries(
      ta.weightedClose(bars, {}),
      bars.map((b) => (b.high + b.low + 2 * b.close) / 4),
      'weightedClose',
    );
    expectSeries(
      ta.averagePrice(bars, {}),
      bars.map((b) => (b.open! + b.high + b.low + b.close) / 4),
      'averagePrice',
    );
    const tr = bars.map((b, i) =>
      i === 0
        ? b.high - b.low
        : Math.max(
            b.high - b.low,
            Math.abs(b.high - bars[i - 1]!.close),
            Math.abs(b.low - bars[i - 1]!.close),
          ),
    );
    expectSeries(ta.trueRange(bars, {}), tr, 'trueRange');
  });
});

// ── momentum ────────────────────────────────────────────────────────────────
describe('golden vectors — momentum', () => {
  it('roc family and momentum', () => {
    const n = 10;
    const roc = closes.map((v, i) => (i < n ? NaN : ((v - closes[i - n]!) / closes[i - n]!) * 100));
    expectSeries(ta.roc(closes, { period: n }), roc, 'roc');
    const rocp = closes.map((v, i) => (i < n ? NaN : (v - closes[i - n]!) / closes[i - n]!));
    expectSeries(ta.rocp(closes, { period: n }), rocp, 'rocp');
    const rocr = closes.map((v, i) => (i < n ? NaN : v / closes[i - n]!));
    expectSeries(ta.rocr(closes, { period: n }), rocr, 'rocr');
    const rocr100 = closes.map((v, i) => (i < n ? NaN : (v / closes[i - n]!) * 100));
    expectSeries(ta.rocr100(closes, { period: n }), rocr100, 'rocr100');
    const mom = closes.map((v, i) => (i < n ? NaN : v - closes[i - n]!));
    expectSeries(ta.momentum(closes, { period: n }), mom, 'momentum');
  });
  it('rsi (Wilder)', () => {
    const n = 14;
    const out = filled(closes.length);
    let averageGain = 0;
    let averageLoss = 0;
    let sumG = 0;
    let sumL = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i]! - closes[i - 1]!;
      const g = ch > 0 ? ch : 0;
      const l = ch < 0 ? -ch : 0;
      if (i <= n) {
        sumG += g;
        sumL += l;
        if (i === n) {
          averageGain = sumG / n;
          averageLoss = sumL / n;
          out[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
        }
      } else {
        averageGain = (averageGain * (n - 1) + g) / n;
        averageLoss = (averageLoss * (n - 1) + l) / n;
        out[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
      }
    }
    expectSeries(ta.rsi(closes, { period: n }), out, 'rsi');
  });
  it('cmo (Chande)', () => {
    const n = 14;
    const out = filled(closes.length);
    for (let i = n; i < closes.length; i++) {
      let up = 0;
      let dn = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const ch = closes[j]! - closes[j - 1]!;
        if (ch > 0) up += ch;
        else dn += -ch;
      }
      out[i] = up + dn === 0 ? 0 : (100 * (up - dn)) / (up + dn);
    }
    expectSeries(ta.cmo(closes, { period: n }), out, 'cmo');
  });
  it('cci', () => {
    const n = 20;
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    const out = filled(bars.length);
    for (let i = n - 1; i < bars.length; i++) {
      const win = tp.slice(i - n + 1, i + 1);
      const mean = win.reduce((s, v) => s + v, 0) / n;
      const md = win.reduce((s, v) => s + Math.abs(v - mean), 0) / n;
      out[i] = md === 0 ? 0 : (tp[i]! - mean) / (0.015 * md);
    }
    expectSeries(ta.cci(bars, { period: n }), out, 'cci');
  });
  it('williamsR', () => {
    const n = 14;
    const out = filled(bars.length);
    for (let i = n - 1; i < bars.length; i++) {
      const hh = Math.max(...highs.slice(i - n + 1, i + 1));
      const ll = Math.min(...lows.slice(i - n + 1, i + 1));
      out[i] = hh === ll ? 0 : (-100 * (hh - closes[i]!)) / (hh - ll);
    }
    expectSeries(ta.williamsR(bars, { period: n }), out, 'williamsR');
  });
  it('bop', () => {
    expectSeries(
      ta.bop(bars, {}),
      bars.map((b) => (b.high === b.low ? 0 : (b.close - b.open!) / (b.high - b.low))),
      'bop',
    );
  });
  it('macd (12/26/9)', () => {
    const ef = emaArr(closes, 12);
    const es = emaArr(closes, 26);
    const macdLine = ef.map((v, i) => (Number.isNaN(v) || Number.isNaN(es[i]!) ? NaN : v - es[i]!));
    const sig = emaOfNanArr(macdLine, 9);
    const out = ta.macd(closes, { fast: 12, slow: 26, signal: 9 });
    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(sig[i]!)) {
        expect(out[i]!.macd, `macd[${i}] warmup`).toBeNaN();
      } else {
        expect(out[i]!.macd, `macd[${i}]`).toBeCloseTo(macdLine[i]!, PREC);
        expect(out[i]!.signal, `signal[${i}]`).toBeCloseTo(sig[i]!, PREC);
        expect(out[i]!.histogram, `hist[${i}]`).toBeCloseTo(macdLine[i]! - sig[i]!, PREC);
      }
    }
  });
  it('stochastic (fast %K, %D = SMA(%K))', () => {
    const kP = 14;
    const dP = 3;
    const kArr = filled(bars.length);
    for (let i = kP - 1; i < bars.length; i++) {
      const hh = Math.max(...highs.slice(i - kP + 1, i + 1));
      const ll = Math.min(...lows.slice(i - kP + 1, i + 1));
      kArr[i] = hh === ll ? 100 : (100 * (closes[i]! - ll)) / (hh - ll);
    }
    // %D is the SMA of %K over its valid region
    const dValid = filled(bars.length);
    for (let i = kP - 1 + (dP - 1); i < bars.length; i++) {
      dValid[i] = (kArr[i]! + kArr[i - 1]! + kArr[i - 2]!) / dP;
    }
    const out = ta.stochastic(bars, { kPeriod: kP, dPeriod: dP });
    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(dValid[i]!)) {
        expect(out[i]!.d, `stoch[${i}] warmup`).toBeNaN();
      } else {
        expect(out[i]!.k, `stochK[${i}]`).toBeCloseTo(kArr[i]!, PREC);
        expect(out[i]!.d, `stochD[${i}]`).toBeCloseTo(dValid[i]!, PREC);
      }
    }
  });
});

// ── volatility ──────────────────────────────────────────────────────────────
describe('golden vectors — volatility', () => {
  it('standardDeviation / variance (population)', () => {
    const n = 20;
    const std = filled(closes.length);
    const varr = filled(closes.length);
    for (let i = n - 1; i < closes.length; i++) {
      const win = closes.slice(i - n + 1, i + 1);
      const mean = win.reduce((s, v) => s + v, 0) / n;
      const v = win.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
      varr[i] = v;
      std[i] = Math.sqrt(v);
    }
    expectSeries(ta.standardDeviation(closes, { period: n }), std, 'standardDeviation');
    expectSeries(ta.variance(closes, { period: n }), varr, 'variance');
  });
  it('bbands (population std, k=2)', () => {
    const n = 20;
    const k = 2;
    const out = ta.bbands(closes, { period: n, standardDeviation: k });
    for (let i = 0; i < closes.length; i++) {
      if (i < n - 1) {
        expect(out[i]!.middle, `bb[${i}] warmup`).toBeNaN();
      } else {
        const win = closes.slice(i - n + 1, i + 1);
        const mean = win.reduce((s, v) => s + v, 0) / n;
        const std = Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
        expect(out[i]!.middle, `bbMid[${i}]`).toBeCloseTo(mean, PREC);
        expect(out[i]!.upper, `bbUp[${i}]`).toBeCloseTo(mean + k * std, PREC);
        expect(out[i]!.lower, `bbLo[${i}]`).toBeCloseTo(mean - k * std, PREC);
      }
    }
  });
  it('atr (Wilder) / natr', () => {
    const n = 14;
    const tr = bars.map((b, i) =>
      i === 0
        ? b.high - b.low
        : Math.max(
            b.high - b.low,
            Math.abs(b.high - bars[i - 1]!.close),
            Math.abs(b.low - bars[i - 1]!.close),
          ),
    );
    const atr = rmaArr(tr, n); // Wilder smoothing of TR, SMA-seeded
    expectSeries(ta.atr(bars, { period: n }), atr, 'atr');
    const natr = atr.map((a, i) => (Number.isNaN(a) ? NaN : (100 * a) / closes[i]!));
    expectSeries(ta.natr(bars, { period: n }), natr, 'natr');
  });
});

// ── volume ──────────────────────────────────────────────────────────────────
describe('golden vectors — volume', () => {
  it('obv', () => {
    const out = filled(bars.length);
    let obv = 0;
    out[0] = 0;
    for (let i = 1; i < bars.length; i++) {
      if (closes[i]! > closes[i - 1]!) obv += bars[i]!.volume!;
      else if (closes[i]! < closes[i - 1]!) obv -= bars[i]!.volume!;
      out[i] = obv;
    }
    expectSeries(ta.obv(bars, {}), out, 'obv');
  });
  it('adLine (Chaikin A/D)', () => {
    const out = filled(bars.length);
    let ad = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const range = b.high - b.low;
      const mfm = range === 0 ? 0 : (b.close - b.low - (b.high - b.close)) / range;
      ad += mfm * b.volume!;
      out[i] = ad;
    }
    expectSeries(ta.adLine(bars, {}), out, 'adLine');
  });
  it('mfi', () => {
    const n = 14;
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    const raw = bars.map((b, i) => tp[i]! * b.volume!);
    const out = filled(bars.length);
    for (let i = n; i < bars.length; i++) {
      let pos = 0;
      let neg = 0;
      for (let j = i - n + 1; j <= i; j++) {
        if (tp[j]! > tp[j - 1]!) pos += raw[j]!;
        else if (tp[j]! < tp[j - 1]!) neg += raw[j]!;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    expectSeries(ta.mfi(bars, { period: n }), out, 'mfi');
  });
});

// ── trend / regression ──────────────────────────────────────────────────────
describe('golden vectors — trend', () => {
  it('linreg / linregSlope / tsf (least squares, x = 0…n−1)', () => {
    const n = 14;
    const slope = filled(closes.length);
    const regVal = filled(closes.length);
    const fc = filled(closes.length);
    const sumX = (n * (n - 1)) / 2;
    const sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
    const denom = n * sumX2 - sumX * sumX;
    for (let i = n - 1; i < closes.length; i++) {
      const win = closes.slice(i - n + 1, i + 1);
      let sumY = 0;
      let sumXY = 0;
      for (let j = 0; j < n; j++) {
        sumY += win[j]!;
        sumXY += j * win[j]!;
      }
      const m = (n * sumXY - sumX * sumY) / denom;
      const b = (sumY - m * sumX) / n;
      slope[i] = m;
      regVal[i] = b + m * (n - 1);
      fc[i] = b + m * n;
    }
    const lr = ta.linreg(closes, { period: n });
    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(regVal[i]!)) expect(lr[i]!.value, `linreg[${i}]`).toBeNaN();
      else expect(lr[i]!.value, `linreg[${i}]`).toBeCloseTo(regVal[i]!, PREC);
    }
    expectSeries(ta.linregSlope(closes, { period: n }), slope, 'linregSlope');
    expectSeries(ta.tsf(closes, { period: n }), fc, 'tsf');
  });
  it('aroon', () => {
    const n = 14;
    const out = ta.aroon(bars, { period: n });
    for (let i = 0; i < bars.length; i++) {
      if (i < n) {
        expect(out[i]!.up, `aroon[${i}] warmup`).toBeNaN();
        continue;
      }
      const wH = highs.slice(i - n, i + 1); // n+1 bars
      const wL = lows.slice(i - n, i + 1);
      let hiIdx = 0;
      let loIdx = 0;
      for (let j = 1; j < wH.length; j++) {
        if (wH[j]! >= wH[hiIdx]!) hiIdx = j;
        if (wL[j]! <= wL[loIdx]!) loIdx = j;
      }
      const sinceHigh = n - hiIdx;
      const sinceLow = n - loIdx;
      expect(out[i]!.up, `aroonUp[${i}]`).toBeCloseTo((100 * (n - sinceHigh)) / n, PREC);
      expect(out[i]!.down, `aroonDown[${i}]`).toBeCloseTo((100 * (n - sinceLow)) / n, PREC);
    }
  });
});

// ── statistics / operators ──────────────────────────────────────────────────
describe('golden vectors — statistics', () => {
  it('rollingMin / rollingMax / rollingSum', () => {
    const n = 10;
    expectSeries(ta.rollingMin(closes, { period: n }), rollMin(closes, n), 'rollingMin');
    expectSeries(ta.rollingMax(closes, { period: n }), rollMax(closes, n), 'rollingMax');
    expectSeries(ta.rollingSum(closes, { period: n }), rollSum(closes, n), 'rollingSum');
  });
});
