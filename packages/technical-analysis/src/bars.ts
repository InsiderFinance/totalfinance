/** Bar-input indicators: ATR, Stochastic, ADX, VWAP, OBV (spec §13.3). */

import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requireBooleanWhenPresent, requirePeriod } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

export interface WilderPeriodParameters {
  /** Wilder lookback. Defaults to 14 for ATR, ADX, ADXR and the DMI family (universal); echoed via `.explain()`. */
  period?: number;
}

// ---- ATR (Wilder) ----

class AtrStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private count = 0;
  private sumTr = 0;
  private atr: number | null = null;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'AtrStream', 'period', 1, 'bars');
  }

  next(bar: BarInput): number | null {
    const tr =
      this.previousClose === null
        ? bar.high - bar.low
        : Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - this.previousClose),
            Math.abs(bar.low - this.previousClose),
          );
    this.previousClose = bar.close;
    this.count++;
    if (this.atr === null) {
      this.sumTr += tr;
      if (this.count === this.period) {
        this.atr = this.sumTr / this.period;
        this.value = this.atr;
        return this.atr;
      }
      this.value = null;
      return null;
    }
    this.atr = (this.atr * (this.period - 1) + tr) / this.period;
    this.value = this.atr;
    return this.atr;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('atr', {
      period: this.period,
      previousClose: this.previousClose,
      count: this.count,
      sumTr: this.sumTr,
      atr: this.atr,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AtrStream {
    const state = readSnapshot(snapshot, 'atr');
    const x = new AtrStream(state.lookback('period'));
    x.previousClose = state.numberOrNull('previousClose');
    x.count = state.number('count');
    x.sumTr = state.number('sumTr');
    x.atr = state.numberOrNull('atr');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ---- Stochastic oscillator ----

export interface StochasticParameters {
  /** %K lookback. Defaults to 14 (Lane; universal); echoed via `.explain()`. */
  kPeriod?: number;
  /** %D smoothing. Defaults to 3 (universal). */
  dPeriod?: number;
  /**
   * SMA smoothing applied to the raw %K before %D — the standard SLOW stochastic (TA-Lib STOCH's
   * `slowk_period`, typically 3). Defaults to 1: no smoothing, i.e. the FAST stochastic.
   */
  smoothK?: number;
}
export interface StochasticPoint {
  k: number;
  d: number;
}

function maxOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  return m;
}
function minOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
  return m;
}

class StochasticStream implements IndicatorStream<BarInput, StochasticPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  /** Raw %K window for the slow-stochastic smoothing (length ≤ smoothK). */
  private rawBuf: number[] = [];
  private kBuf: number[] = [];
  value: StochasticPoint | null = null;
  private readonly kPeriod: number;
  private readonly dPeriod: number;
  private readonly smoothK: number;
  constructor(parameters: { kPeriod: number; dPeriod: number; smoothK?: number }) {
    requireStreamParameters('StochasticStream.constructor#0', 'StochasticStream', parameters);
    const { kPeriod, dPeriod, smoothK = 1 } = parameters;
    this.kPeriod = kPeriod;
    this.dPeriod = dPeriod;
    this.smoothK = smoothK;
  }

  next(bar: BarInput): StochasticPoint | null {
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.kPeriod) {
      this.highs.shift();
      this.lows.shift();
    }
    if (this.highs.length < this.kPeriod) {
      this.value = null;
      return null;
    }
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    // Flat window (`hh === ll`, a halt or a limit-locked session): the stochastic is 0/0. Both
    // certified references resolve it to **0** — TA-Lib's STOCH/STOCHF (measured: 0 on a flat
    // series, v0.6.x) and pandas-ta's `stoch` — and TotalFinance's own `stochRsi` already did, so the
    // family now answers with one number instead of two. (Note this is NOT the same degenerate case
    // as RSI's, which stays at 100: there the limit RS → ∞ is one-sided, here the window carries no
    // direction at all.)
    const rawK = hh === ll ? 0 : (100 * (bar.close - ll)) / (hh - ll);
    // Slow-stochastic smoothing: %K = SMA(raw %K, smoothK). smoothK = 1 keeps the fast %K.
    this.rawBuf.push(rawK);
    if (this.rawBuf.length > this.smoothK) this.rawBuf.shift();
    if (this.rawBuf.length < this.smoothK) {
      this.value = null;
      return null;
    }
    let rawSum = 0;
    for (const x of this.rawBuf) rawSum += x;
    const k = rawSum / this.smoothK;
    this.kBuf.push(k);
    if (this.kBuf.length > this.dPeriod) this.kBuf.shift();
    if (this.kBuf.length < this.dPeriod) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.kBuf) sum += x;
    this.value = { k, d: sum / this.dPeriod };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('stochastic', {
      kPeriod: this.kPeriod,
      dPeriod: this.dPeriod,
      smoothK: this.smoothK,
      highs: [...this.highs],
      lows: [...this.lows],
      rawBuf: [...this.rawBuf],
      kBuf: [...this.kBuf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): StochasticStream {
    const state = readSnapshot(snapshot, 'stochastic');
    // Pre-smoothK snapshots (no `smoothK`/`rawBuf`) restore as the fast stochastic — same behavior.
    const x = new StochasticStream({
      kPeriod: state.lookback('kPeriod'),
      dPeriod: state.lookback('dPeriod'),
      smoothK: state.optionalNumber('smoothK') ?? 1,
    });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.rawBuf = [...(state.optionalNumbers('rawBuf') ?? [])];
    x.kBuf = state.numbers('kBuf');
    x.value = state.cached<StochasticPoint>('value');
    return x;
  }
}

// ---- ADX (Wilder) ----

export interface AdxPoint {
  adx: number;
  plusDI: number;
  minusDI: number;
}

class AdxStream implements IndicatorStream<BarInput, AdxPoint> {
  private prevHigh: number | null = null;
  private prevLow = 0;
  private previousClose = 0;
  private count = 0;
  private trSum = 0;
  private pdmSum = 0;
  private mdmSum = 0;
  private smTr = 0;
  private smPdm = 0;
  private smMdm = 0;
  private smoothed = false;
  private dxCount = 0;
  private dxSum = 0;
  private adx: number | null = null;
  private adxSeeded = false;
  value: AdxPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'AdxStream', 'period', 1, 'bars');
  }

  next(bar: BarInput): AdxPoint | null {
    if (this.prevHigh === null) {
      this.prevHigh = bar.high;
      this.prevLow = bar.low;
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const upMove = bar.high - this.prevHigh;
    const downMove = this.prevLow - bar.low;
    const pdm = upMove > downMove && upMove > 0 ? upMove : 0;
    const mdm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - this.previousClose),
      Math.abs(bar.low - this.previousClose),
    );
    this.prevHigh = bar.high;
    this.prevLow = bar.low;
    this.previousClose = bar.close;

    if (!this.smoothed) {
      this.count++;
      this.trSum += tr;
      this.pdmSum += pdm;
      this.mdmSum += mdm;
      if (this.count === this.period) {
        this.smTr = this.trSum;
        this.smPdm = this.pdmSum;
        this.smMdm = this.mdmSum;
        this.smoothed = true;
      } else {
        this.value = null;
        return null;
      }
    } else {
      this.smTr = this.smTr - this.smTr / this.period + tr;
      this.smPdm = this.smPdm - this.smPdm / this.period + pdm;
      this.smMdm = this.smMdm - this.smMdm / this.period + mdm;
    }

    const pDI = this.smTr === 0 ? 0 : (100 * this.smPdm) / this.smTr;
    const mDI = this.smTr === 0 ? 0 : (100 * this.smMdm) / this.smTr;
    const diSum = pDI + mDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / diSum;

    if (!this.adxSeeded) {
      this.dxCount++;
      this.dxSum += dx;
      if (this.dxCount === this.period) {
        this.adx = this.dxSum / this.period;
        this.adxSeeded = true;
        this.value = { adx: this.adx, plusDI: pDI, minusDI: mDI };
        return this.value;
      }
      this.value = null;
      return null;
    }
    this.adx = (this.adx! * (this.period - 1) + dx) / this.period;
    this.value = { adx: this.adx, plusDI: pDI, minusDI: mDI };
    return this.value;
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('adx', {
      period: this.period,
      prevHigh: this.prevHigh,
      prevLow: this.prevLow,
      previousClose: this.previousClose,
      count: this.count,
      trSum: this.trSum,
      pdmSum: this.pdmSum,
      mdmSum: this.mdmSum,
      smTr: this.smTr,
      smPdm: this.smPdm,
      smMdm: this.smMdm,
      smoothed: this.smoothed,
      dxCount: this.dxCount,
      dxSum: this.dxSum,
      adx: this.adx,
      adxSeeded: this.adxSeeded,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AdxStream {
    const state = readSnapshot(snapshot, 'adx');
    const x = new AdxStream(state.lookback('period'));
    Object.assign(x, {
      prevHigh: state.numberOrNull('prevHigh'),
      prevLow: state.number('prevLow'),
      previousClose: state.number('previousClose'),
      count: state.number('count'),
      trSum: state.number('trSum'),
      pdmSum: state.number('pdmSum'),
      mdmSum: state.number('mdmSum'),
      smTr: state.number('smTr'),
      smPdm: state.number('smPdm'),
      smMdm: state.number('smMdm'),
      smoothed: state.boolean('smoothed'),
      dxCount: state.number('dxCount'),
      dxSum: state.number('dxSum'),
      adx: state.numberOrNull('adx'),
      adxSeeded: state.boolean('adxSeeded'),
      value: state.cached<AdxPoint>('value'),
    });
    return x;
  }
}

// ---- VWAP (cumulative) ----

class VwapStream implements IndicatorStream<BarInput, number> {
  private cumPV = 0;
  private cumV = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume ?? 0;
    this.cumPV += tp * v;
    this.cumV += v;
    this.value = this.cumV === 0 ? tp : this.cumPV / this.cumV;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vwap', { cumPV: this.cumPV, cumV: this.cumV, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VwapStream {
    const state = readSnapshot(snapshot, 'vwap');
    const x = new VwapStream();
    x.cumPV = state.number('cumPV');
    x.cumV = state.number('cumV');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ---- OBV ----

class ObvStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private obv = 0;
  value: number | null = null;
  // TA-Lib seeds OBV at `volume[0]`; TotalFinance seeds at 0 (the series differ by that constant — deltas
  // are identical). `talib: true` reproduces TA-Lib's absolute level exactly.
  constructor(private readonly talib = false) {}
  next(bar: BarInput): number | null {
    const v = bar.volume ?? 0;
    if (this.previousClose === null) {
      if (this.talib) this.obv = v;
    } else if (bar.close > this.previousClose) this.obv += v;
    else if (bar.close < this.previousClose) this.obv -= v;
    this.previousClose = bar.close;
    this.value = this.obv;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('obv', {
      talib: this.talib,
      previousClose: this.previousClose,
      obv: this.obv,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ObvStream {
    const state = readSnapshot(snapshot, 'obv');
    const x = new ObvStream(Boolean(state.boolean('talib')));
    x.previousClose = state.numberOrNull('previousClose');
    x.obv = state.number('obv');
    x.value = state.cached<number>('value');
    return x;
  }
}

const nan = (): number => NaN;

export const atr = makeIndicator<WilderPeriodParameters, BarInput, number>(
  (p) => new AtrStream(requirePeriod(p.period ?? 14, 'atr')),
  AtrStream.fromJSON,
  nan,
  { period: 14 },
);
export const stochastic = makeIndicator<StochasticParameters, BarInput, StochasticPoint>(
  (p) =>
    new StochasticStream({
      kPeriod: requirePeriod(p.kPeriod ?? 14, 'stochastic', 'kPeriod'),
      dPeriod: requirePeriod(p.dPeriod ?? 3, 'stochastic', 'dPeriod'),
      smoothK: requirePeriod(p.smoothK ?? 1, 'stochastic', 'smoothK'),
    }),
  StochasticStream.fromJSON,
  () => ({ k: NaN, d: NaN }),
  { kPeriod: 14, dPeriod: 3, smoothK: 1 },
);

/**
 * Alias of {@link stochastic}: with the default `smoothK: 1` the stochastic IS the fast stochastic
 * (raw %K + SMA %D — TA-Lib STOCHF). One implementation, two registry names; pass `smoothK: 3` for
 * the classic slow stochastic (TA-Lib STOCH's slowk).
 */
export const stochFast = stochastic;
export const adx = makeIndicator<WilderPeriodParameters, BarInput, AdxPoint>(
  (p) => new AdxStream(requirePeriod(p.period ?? 14, 'adx')),
  AdxStream.fromJSON,
  () => ({ adx: NaN, plusDI: NaN, minusDI: NaN }),
  { period: 14 },
);
export const vwap = makeIndicator<Record<never, never>, BarInput, number>(
  () => new VwapStream(),
  VwapStream.fromJSON,
  nan,
);
export const obv = makeIndicator<{ talib?: boolean }, BarInput, number>(
  (p) => new ObvStream(requireBooleanWhenPresent(p?.talib, 'obv', 'talib') ?? false),
  ObvStream.fromJSON,
  nan,
);

export { AtrStream, StochasticStream, AdxStream, VwapStream, ObvStream };
