/**
 * Trend & directional indicators (spec §13.3).
 *
 * DMI (+DI/−DI/DX), ADXR, Aroon & Aroon Oscillator, Parabolic SAR, Supertrend, Ichimoku, Vortex,
 * linear-regression (value / slope / intercept / angle) and Time-Series Forecast, Chandelier exits,
 * and ZigZag. ADX itself lives in `./bars`. Each indicator is a serializable stream wrapped into the
 * aligned batch+stream facade; ZigZag is a batch function (its final leg is provisional by nature).
 */

import type { QuantWarning } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { AtrStream, type WilderPeriodParameters } from './bars.js';
import { dirtyRows, isDirtySample } from './nan-policy.js';
import {
  requireAtMost,
  requireBars,
  requireFinite,
  requirePeriod,
  requirePositive,
} from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nanNum = (): number => NaN;

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

export interface PeriodParameters {
  period: number;
}

// ───────── projection helper: expose one field of a record indicator as a number facade ─────────

class ProjectStream<In, R extends object> implements IndicatorStream<In, number> {
  value: number | null = null;
  constructor(
    private readonly inner: IndicatorStream<In, R>,
    private readonly field: keyof R & string,
    private readonly kind: string,
  ) {}
  next(x: In): number | null {
    const r = this.inner.next(x);
    this.value = r === null ? null : (r[this.field] as number);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `field` is NOT serialized: `projected(kind, …, field)` binds it, so a stored copy reads back
    // as a field nothing consults.
    return snapshotOf(this.kind, {
      inner: this.inner.toJSON(),
      value: this.value,
    });
  }
}

function projected<P, In, R extends object>(
  kind: string,
  makeInner: (p: P) => IndicatorStream<In, R>,
  restoreInner: (s: TechnicalAnalysisSnapshot) => IndicatorStream<In, R>,
  field: keyof R & string,
  defaults?: Record<string, unknown>,
) {
  return makeIndicator<P, In, number>(
    (p) => new ProjectStream(makeInner(p), field, kind),
    (s) => {
      const state = readSnapshot(s, kind);
      const x = new ProjectStream(restoreInner(state.child('inner')), field, kind);
      x.value = state.cached<number>('value');
      return x;
    },
    nanNum,
    defaults,
  );
}

// ───────────────────────── DMI (+DI / −DI / DX) ─────────────────────────

export interface DmiPoint {
  plusDI: number;
  minusDI: number;
  dx: number;
  /** Wilder-smoothed +DM. */
  plusDM: number;
  /** Wilder-smoothed −DM. */
  minusDM: number;
}

class DmiStream implements IndicatorStream<BarInput, DmiPoint> {
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
  value: DmiPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'DmiStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): DmiPoint | null {
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
    const plusDI = this.smTr === 0 ? 0 : (100 * this.smPdm) / this.smTr;
    const minusDI = this.smTr === 0 ? 0 : (100 * this.smMdm) / this.smTr;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;
    this.value = { plusDI, minusDI, dx, plusDM: this.smPdm, minusDM: this.smMdm };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('dmi', {
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
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DmiStream {
    const state = readSnapshot(snapshot, 'dmi');
    const x = new DmiStream(state.lookback('period'));
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
    });
    x.value = state.cached<DmiPoint>('value');
    return x;
  }
}

export const dmi = makeIndicator<WilderPeriodParameters, BarInput, DmiPoint>(
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'dmi')),
  DmiStream.fromJSON,
  () => ({ plusDI: NaN, minusDI: NaN, dx: NaN, plusDM: NaN, minusDM: NaN }),
  { period: 14 },
);
export const plusDI = projected<WilderPeriodParameters, BarInput, DmiPoint>(
  'plusDI',
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'plusDI')),
  DmiStream.fromJSON,
  'plusDI',
  { period: 14 },
);
export const minusDI = projected<WilderPeriodParameters, BarInput, DmiPoint>(
  'minusDI',
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'minusDI')),
  DmiStream.fromJSON,
  'minusDI',
  { period: 14 },
);
export const dx = projected<WilderPeriodParameters, BarInput, DmiPoint>(
  'dx',
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'dx')),
  DmiStream.fromJSON,
  'dx',
  { period: 14 },
);
export const plusDM = projected<WilderPeriodParameters, BarInput, DmiPoint>(
  'plusDM',
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'plusDM', 'period', 1, 'bars')),
  DmiStream.fromJSON,
  'plusDM',
  { period: 14 },
);
export const minusDM = projected<WilderPeriodParameters, BarInput, DmiPoint>(
  'minusDM',
  (p) => new DmiStream(requirePeriod(p.period ?? 14, 'minusDM', 'period', 1, 'bars')),
  DmiStream.fromJSON,
  'minusDM',
  { period: 14 },
);

// ───────────────────────── ADXR ─────────────────────────

class AdxrStream implements IndicatorStream<BarInput, number> {
  private dmiInner: DmiStream;
  private dxCount = 0;
  private dxSum = 0;
  private adx: number | null = null;
  private adxBuf: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'AdxrStream', 'period', 1, 'bars');
    this.dmiInner = new DmiStream(period);
  }
  next(bar: BarInput): number | null {
    const d = this.dmiInner.next(bar);
    if (d === null) {
      this.value = null;
      return null;
    }
    const dxv = d.dx;
    if (this.adx === null) {
      this.dxCount++;
      this.dxSum += dxv;
      if (this.dxCount === this.period) this.adx = this.dxSum / this.period;
      else {
        this.value = null;
        return null;
      }
    } else {
      this.adx = (this.adx * (this.period - 1) + dxv) / this.period;
    }
    this.adxBuf.push(this.adx);
    if (this.adxBuf.length > this.period + 1) this.adxBuf.shift();
    if (this.adxBuf.length < this.period + 1) {
      this.value = null;
      return null;
    }
    this.value = (this.adx + this.adxBuf[0]!) / 2;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('adxr', {
      period: this.period,
      dmi: this.dmiInner.toJSON(),
      dxCount: this.dxCount,
      dxSum: this.dxSum,
      adx: this.adx,
      adxBuf: [...this.adxBuf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AdxrStream {
    const state = readSnapshot(snapshot, 'adxr');
    const x = new AdxrStream(state.lookback('period'));
    x.dmiInner = DmiStream.fromJSON(state.child('dmi'));
    Object.assign(x, {
      dxCount: state.number('dxCount'),
      dxSum: state.number('dxSum'),
      adx: state.numberOrNull('adx'),
    });
    x.adxBuf = state.numbers('adxBuf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const adxr = makeIndicator<WilderPeriodParameters, BarInput, number>(
  (p) => new AdxrStream(requirePeriod(p.period ?? 14, 'adxr')),
  AdxrStream.fromJSON,
  nanNum,
  { period: 14 },
);

// ───────────────────────── Aroon ─────────────────────────

export interface AroonPoint {
  up: number;
  down: number;
}

class AroonStream implements IndicatorStream<BarInput, AroonPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: AroonPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'AroonStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): AroonPoint | null {
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    const length = this.period + 1;
    if (this.highs.length > length) {
      this.highs.shift();
      this.lows.shift();
    }
    if (this.highs.length < length) {
      this.value = null;
      return null;
    }
    // bars since the highest high / lowest low within the window
    let hiIdx = 0;
    let loIdx = 0;
    for (let i = 1; i < length; i++) {
      if (this.highs[i]! >= this.highs[hiIdx]!) hiIdx = i;
      if (this.lows[i]! <= this.lows[loIdx]!) loIdx = i;
    }
    const sinceHigh = length - 1 - hiIdx;
    const sinceLow = length - 1 - loIdx;
    this.value = {
      up: (100 * (this.period - sinceHigh)) / this.period,
      down: (100 * (this.period - sinceLow)) / this.period,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('aroon', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AroonStream {
    const state = readSnapshot(snapshot, 'aroon');
    const x = new AroonStream(state.lookback('period'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<AroonPoint>('value');
    return x;
  }
}

export const aroon = makeIndicator<{ period?: number }, BarInput, AroonPoint>(
  (p) => new AroonStream(requirePeriod(p.period ?? 14, 'aroon')),
  AroonStream.fromJSON,
  () => ({ up: NaN, down: NaN }),
  { period: 14 },
);

class AroonOscStream implements IndicatorStream<BarInput, number> {
  private inner: AroonStream;
  value: number | null = null;
  constructor(period: number) {
    this.inner = new AroonStream(period);
  }
  next(bar: BarInput): number | null {
    const r = this.inner.next(bar);
    this.value = r === null ? null : r.up - r.down;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('aroonOsc', { inner: this.inner.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AroonOscStream {
    const state = readSnapshot(snapshot, 'aroonOsc');
    const x = new AroonOscStream(1);
    x.inner = AroonStream.fromJSON(state.child('inner'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const aroonOscillator = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new AroonOscStream(requirePeriod(p.period ?? 14, 'aroonOscillator', 'period', 1, 'bars')),
  AroonOscStream.fromJSON,
  nanNum,
  { period: 14 },
);

// ───────────────────────── Parabolic SAR ─────────────────────────

export interface PsarParameters {
  step?: number;
  max?: number;
}
export interface PsarPoint {
  sar: number;
  /** +1 rising (long), −1 falling (short). */
  trend: number;
}

class PsarStream implements IndicatorStream<BarInput, PsarPoint> {
  private count = 0;
  private prevHigh1 = 0;
  private prevHigh2 = 0;
  private prevLow1 = 0;
  private prevLow2 = 0;
  private sar = 0;
  private ep = 0;
  private af = 0;
  private trend = 0;
  value: PsarPoint | null = null;
  private readonly step: number;
  private readonly maxAf: number;
  constructor(parameters: { step: number; maxAf: number }) {
    requireStreamParameters('PsarStream.constructor#0', 'PsarStream', parameters);
    const { step, maxAf } = parameters;
    this.step = step;
    this.maxAf = maxAf;
  }
  next(bar: BarInput): PsarPoint | null {
    this.count++;
    if (this.count === 1) {
      this.prevHigh1 = bar.high;
      this.prevLow1 = bar.low;
      this.value = null;
      return null;
    }
    if (this.count === 2) {
      const up = bar.close >= this.prevLow1; // crude initial direction vs first bar
      this.trend = up ? 1 : -1;
      if (up) {
        this.sar = this.prevLow1;
        this.ep = bar.high;
      } else {
        this.sar = this.prevHigh1;
        this.ep = bar.low;
      }
      this.af = this.step;
      this.prevHigh2 = this.prevHigh1;
      this.prevLow2 = this.prevLow1;
      this.prevHigh1 = bar.high;
      this.prevLow1 = bar.low;
      this.value = { sar: this.sar, trend: this.trend };
      return this.value;
    }

    let sar = this.sar + this.af * (this.ep - this.sar);
    if (this.trend === 1) {
      sar = Math.min(sar, this.prevLow1, this.prevLow2);
      if (bar.high > this.ep) {
        this.ep = bar.high;
        this.af = Math.min(this.af + this.step, this.maxAf);
      }
      if (bar.low < sar) {
        this.trend = -1;
        sar = this.ep;
        this.ep = bar.low;
        this.af = this.step;
      }
    } else {
      sar = Math.max(sar, this.prevHigh1, this.prevHigh2);
      if (bar.low < this.ep) {
        this.ep = bar.low;
        this.af = Math.min(this.af + this.step, this.maxAf);
      }
      if (bar.high > sar) {
        this.trend = 1;
        sar = this.ep;
        this.ep = bar.high;
        this.af = this.step;
      }
    }
    this.sar = sar;
    this.prevHigh2 = this.prevHigh1;
    this.prevLow2 = this.prevLow1;
    this.prevHigh1 = bar.high;
    this.prevLow1 = bar.low;
    this.value = { sar, trend: this.trend };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('psar', {
      step: this.step,
      maxAf: this.maxAf,
      count: this.count,
      prevHigh1: this.prevHigh1,
      prevHigh2: this.prevHigh2,
      prevLow1: this.prevLow1,
      prevLow2: this.prevLow2,
      sar: this.sar,
      ep: this.ep,
      af: this.af,
      trend: this.trend,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PsarStream {
    const state = readSnapshot(snapshot, 'psar');
    const x = new PsarStream({
      step: state.number('step'),
      maxAf: state.number('maxAf'),
    });
    Object.assign(x, {
      count: state.number('count'),
      prevHigh1: state.number('prevHigh1'),
      prevHigh2: state.number('prevHigh2'),
      prevLow1: state.number('prevLow1'),
      prevLow2: state.number('prevLow2'),
      sar: state.number('sar'),
      ep: state.number('ep'),
      af: state.number('af'),
      trend: state.number('trend'),
    });
    x.value = state.cached<PsarPoint>('value');
    return x;
  }
}

export const psar = makeIndicator<PsarParameters, BarInput, PsarPoint>(
  (p) => {
    const step = requirePositive(p.step ?? 0.02, 'psar', 'step');
    const max = requirePositive(p.max ?? 0.2, 'psar', 'max');
    requireAtMost(step, max, 'psar', 'step', 'max');
    return new PsarStream({ step, maxAf: max });
  },
  PsarStream.fromJSON,
  () => ({ sar: NaN, trend: NaN }),
);

// ───────────────────────── Extended SAR (SAREXT) ─────────────────────────

export interface PsarExtParameters {
  /** Force the initial direction: >0 long, <0 short, 0 auto. Default 0. */
  startValue?: number;
  /** Widen the SAR by this fraction of the extreme point on a reversal. Default 0. */
  offsetOnReverse?: number;
  accelInitLong?: number;
  accelLong?: number;
  accelMaxLong?: number;
  accelInitShort?: number;
  accelShort?: number;
  accelMaxShort?: number;
}

/**
 * TA-Lib SAREXT — Parabolic SAR with independent acceleration factors per side and an offset applied
 * on reversal. Output is signed: positive while long, negative while short.
 */
class PsarExtStream implements IndicatorStream<BarInput, number> {
  private count = 0;
  private prevHigh1 = 0;
  private prevHigh2 = 0;
  private prevLow1 = 0;
  private prevLow2 = 0;
  private sar = 0;
  private ep = 0;
  private af = 0;
  private trend = 0;
  value: number | null = null;
  private readonly startValue: number;
  private readonly offset: number;
  private readonly afInitLong: number;
  private readonly afLong: number;
  private readonly afMaxLong: number;
  private readonly afInitShort: number;
  private readonly afShort: number;
  private readonly afMaxShort: number;
  constructor(parameters: {
    startValue: number;
    offset: number;
    afInitLong: number;
    afLong: number;
    afMaxLong: number;
    afInitShort: number;
    afShort: number;
    afMaxShort: number;
  }) {
    requireStreamParameters('PsarExtStream.constructor#0', 'PsarExtStream', parameters);
    const { startValue, offset, afInitLong, afLong, afMaxLong, afInitShort, afShort, afMaxShort } =
      parameters;
    this.startValue = startValue;
    this.offset = offset;
    this.afInitLong = afInitLong;
    this.afLong = afLong;
    this.afMaxLong = afMaxLong;
    this.afInitShort = afInitShort;
    this.afShort = afShort;
    this.afMaxShort = afMaxShort;
  }
  next(bar: BarInput): number | null {
    this.count++;
    if (this.count === 1) {
      this.prevHigh1 = bar.high;
      this.prevLow1 = bar.low;
      this.value = null;
      return null;
    }
    if (this.count === 2) {
      const up = this.startValue !== 0 ? this.startValue > 0 : bar.close >= this.prevLow1;
      this.trend = up ? 1 : -1;
      if (up) {
        this.sar = this.prevLow1;
        this.ep = bar.high;
        this.af = this.afInitLong;
      } else {
        this.sar = this.prevHigh1;
        this.ep = bar.low;
        this.af = this.afInitShort;
      }
      this.prevHigh2 = this.prevHigh1;
      this.prevLow2 = this.prevLow1;
      this.prevHigh1 = bar.high;
      this.prevLow1 = bar.low;
      this.value = this.trend === 1 ? this.sar : -this.sar;
      return this.value;
    }
    let sar = this.sar + this.af * (this.ep - this.sar);
    if (this.trend === 1) {
      sar = Math.min(sar, this.prevLow1, this.prevLow2);
      if (bar.high > this.ep) {
        this.ep = bar.high;
        this.af = Math.min(this.af + this.afLong, this.afMaxLong);
      }
      if (bar.low < sar) {
        this.trend = -1;
        sar = this.ep + this.offset * (this.ep - this.sar);
        this.ep = bar.low;
        this.af = this.afInitShort;
      }
    } else {
      sar = Math.max(sar, this.prevHigh1, this.prevHigh2);
      if (bar.low < this.ep) {
        this.ep = bar.low;
        this.af = Math.min(this.af + this.afShort, this.afMaxShort);
      }
      if (bar.high > sar) {
        this.trend = 1;
        sar = this.ep - this.offset * (this.sar - this.ep);
        this.ep = bar.high;
        this.af = this.afInitLong;
      }
    }
    this.sar = sar;
    this.prevHigh2 = this.prevHigh1;
    this.prevLow2 = this.prevLow1;
    this.prevHigh1 = bar.high;
    this.prevLow1 = bar.low;
    this.value = this.trend === 1 ? sar : -sar;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('psarExt', {
      startValue: this.startValue,
      offset: this.offset,
      afInitLong: this.afInitLong,
      afLong: this.afLong,
      afMaxLong: this.afMaxLong,
      afInitShort: this.afInitShort,
      afShort: this.afShort,
      afMaxShort: this.afMaxShort,
      count: this.count,
      prevHigh1: this.prevHigh1,
      prevHigh2: this.prevHigh2,
      prevLow1: this.prevLow1,
      prevLow2: this.prevLow2,
      sar: this.sar,
      ep: this.ep,
      af: this.af,
      trend: this.trend,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PsarExtStream {
    const state = readSnapshot(snapshot, 'psarExt');
    const x = new PsarExtStream({
      startValue: state.number('startValue'),
      offset: state.number('offset'),
      afInitLong: state.number('afInitLong'),
      afLong: state.number('afLong'),
      afMaxLong: state.number('afMaxLong'),
      afInitShort: state.number('afInitShort'),
      afShort: state.number('afShort'),
      afMaxShort: state.number('afMaxShort'),
    });
    Object.assign(x, {
      count: state.number('count'),
      prevHigh1: state.number('prevHigh1'),
      prevHigh2: state.number('prevHigh2'),
      prevLow1: state.number('prevLow1'),
      prevLow2: state.number('prevLow2'),
      sar: state.number('sar'),
      ep: state.number('ep'),
      af: state.number('af'),
      trend: state.number('trend'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const psarExt = makeIndicator<PsarExtParameters, BarInput, number>(
  (p) => {
    const accelInitLong = requirePositive(p.accelInitLong ?? 0.02, 'psarExt', 'accelInitLong');
    const accelLong = requirePositive(p.accelLong ?? 0.02, 'psarExt', 'accelLong');
    const accelMaxLong = requirePositive(p.accelMaxLong ?? 0.2, 'psarExt', 'accelMaxLong');
    const accelInitShort = requirePositive(p.accelInitShort ?? 0.02, 'psarExt', 'accelInitShort');
    const accelShort = requirePositive(p.accelShort ?? 0.02, 'psarExt', 'accelShort');
    const accelMaxShort = requirePositive(p.accelMaxShort ?? 0.2, 'psarExt', 'accelMaxShort');
    requireAtMost(accelInitLong, accelMaxLong, 'psarExt', 'accelInitLong', 'accelMaxLong');
    requireAtMost(accelLong, accelMaxLong, 'psarExt', 'accelLong', 'accelMaxLong');
    requireAtMost(accelInitShort, accelMaxShort, 'psarExt', 'accelInitShort', 'accelMaxShort');
    requireAtMost(accelShort, accelMaxShort, 'psarExt', 'accelShort', 'accelMaxShort');
    return new PsarExtStream({
      startValue: requireFinite(p.startValue ?? 0, 'psarExt', 'startValue'),
      offset: requireFinite(p.offsetOnReverse ?? 0, 'psarExt', 'offsetOnReverse'),
      afInitLong: accelInitLong,
      afLong: accelLong,
      afMaxLong: accelMaxLong,
      afInitShort: accelInitShort,
      afShort: accelShort,
      afMaxShort: accelMaxShort,
    });
  },
  PsarExtStream.fromJSON,
  nanNum,
);

// ───────────────────────── Donchian trend ─────────────────────────

/**
 * Donchian breakout trend: +1 once the close makes a new `period`-bar high, −1 on a new `period`-bar
 * low, holding the prior state between breakouts.
 */
class DonchianTrendStream implements IndicatorStream<BarInput, number> {
  private highs: number[] = [];
  private lows: number[] = [];
  private trend = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'DonchianTrendStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    if (this.highs.length >= this.period) {
      const upper = maxOf(this.highs);
      const lower = minOf(this.lows);
      if (bar.close >= upper) this.trend = 1;
      else if (bar.close <= lower) this.trend = -1;
    }
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.period) {
      this.highs.shift();
      this.lows.shift();
    }
    if (this.highs.length < this.period || this.trend === 0) {
      this.value = this.highs.length < this.period ? null : 0;
      return this.value;
    }
    this.value = this.trend;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('donchianTrend', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      trend: this.trend,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DonchianTrendStream {
    const state = readSnapshot(snapshot, 'donchianTrend');
    const x = new DonchianTrendStream(state.lookback('period'));
    Object.assign(x, { trend: state.number('trend') });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const donchianTrend = makeIndicator<{ period?: number }, BarInput, number>(
  (p) =>
    new DonchianTrendStream(requirePeriod(p.period ?? 20, 'donchianTrend', 'period', 1, 'bars')),
  DonchianTrendStream.fromJSON,
  nanNum,
  { period: 20 },
);

// ───────────────────────── Supertrend ─────────────────────────

export interface SupertrendParameters {
  period: number;
  multiplier?: number;
}
export interface SupertrendPoint {
  supertrend: number;
  /** +1 uptrend (price above), −1 downtrend (price below). */
  direction: number;
}

class SupertrendStream implements IndicatorStream<BarInput, SupertrendPoint> {
  private atr: AtrStream;
  private previousClose = 0;
  private prevUpper = 0;
  private prevLower = 0;
  private prevST = 0;
  private started = false;
  value: SupertrendPoint | null = null;
  private readonly mult: number;
  constructor(parameters: { period: number; mult: number }) {
    requireStreamParameters('SupertrendStream.constructor#0', 'SupertrendStream', parameters);
    const { period, mult } = parameters;
    this.mult = mult;

    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): SupertrendPoint | null {
    const atr = this.atr.next(bar);
    if (atr === null) {
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const hl2 = (bar.high + bar.low) / 2;
    const basicUpper = hl2 + this.mult * atr;
    const basicLower = hl2 - this.mult * atr;
    if (!this.started) {
      this.prevUpper = basicUpper;
      this.prevLower = basicLower;
      // Seed LONG (the lower band), matching pandas-ta (`dir_ = [1] * m`) and TradingView: the first
      // emitted bar reads `direction: +1` with the line under price. Seeding at the upper band
      // instead made the opening bars unconditionally `-1` regardless of the data, an artifact of
      // the seed rather than a signal. Both seeds agree from the first genuine flip onward.
      this.prevST = basicLower;
      this.started = true;
    }
    const finalUpper =
      basicUpper < this.prevUpper || this.previousClose > this.prevUpper
        ? basicUpper
        : this.prevUpper;
    const finalLower =
      basicLower > this.prevLower || this.previousClose < this.prevLower
        ? basicLower
        : this.prevLower;
    let st: number;
    if (this.prevST === this.prevUpper) {
      st = bar.close <= finalUpper ? finalUpper : finalLower;
    } else {
      st = bar.close >= finalLower ? finalLower : finalUpper;
    }
    const direction = st === finalLower ? 1 : -1;
    this.previousClose = bar.close;
    this.prevUpper = finalUpper;
    this.prevLower = finalLower;
    this.prevST = st;
    this.value = { supertrend: st, direction };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('supertrend', {
      atr: this.atr.toJSON(),
      mult: this.mult,
      previousClose: this.previousClose,
      prevUpper: this.prevUpper,
      prevLower: this.prevLower,
      prevST: this.prevST,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SupertrendStream {
    const state = readSnapshot(snapshot, 'supertrend');
    const x = new SupertrendStream({ period: 1, mult: state.number('mult') });
    x.atr = AtrStream.fromJSON(state.child('atr'));
    Object.assign(x, {
      previousClose: state.number('previousClose'),
      prevUpper: state.number('prevUpper'),
      prevLower: state.number('prevLower'),
      prevST: state.number('prevST'),
      started: state.boolean('started'),
    });
    x.value = state.cached<SupertrendPoint>('value');
    return x;
  }
}

export const supertrend = makeIndicator<SupertrendParameters, BarInput, SupertrendPoint>(
  (p) =>
    new SupertrendStream({
      period: requirePeriod(p.period, 'supertrend', 'period', 1, 'bars'),
      mult: requirePositive(p.multiplier ?? 3, 'supertrend', 'multiplier'),
    }),
  SupertrendStream.fromJSON,
  () => ({ supertrend: NaN, direction: NaN }),
);

// ───────────────────────── Ichimoku ─────────────────────────

export interface IchimokuParameters {
  conversion?: number;
  base?: number;
  spanB?: number;
  /**
   * Plotting displacement in bars (default 26). Echoed on each point as `displacement`; the component
   * values themselves are NOT shifted (see `IchimokuPoint`).
   */
  displacement?: number;
}
/**
 * Ichimoku components computed causally at the current bar — **no look-ahead, no shifting**. To draw a
 * standard Ichimoku cloud, plot `senkouA`/`senkouB` shifted **forward** by `displacement` bars and
 * `chikou` shifted **backward** by `displacement` bars; `displacement` is echoed here so the caller
 * knows the offset to apply.
 */
export interface IchimokuPoint {
  /** Conversion line (Tenkan-sen): midpoint of the last `conversion` bars. */
  tenkan: number;
  /** Base line (Kijun-sen): midpoint of the last `base` bars. */
  kijun: number;
  /** Leading span A (Senkou A), unshifted: (tenkan + kijun) / 2 — plot `displacement` bars ahead. */
  senkouA: number;
  /** Leading span B (Senkou B), unshifted: midpoint of the last `spanB` bars — plot `displacement` bars ahead. */
  senkouB: number;
  /** Lagging span (Chikou): the current close — plot `displacement` bars behind. */
  chikou: number;
  /** The displacement (in bars) to apply when plotting the spans/chikou. */
  displacement: number;
}

class IchimokuStream implements IndicatorStream<BarInput, IchimokuPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: IchimokuPoint | null = null;
  private readonly conv: number;
  private readonly basePeriod: number;
  private readonly spanBPeriod: number;
  private readonly displacement: number;
  /**
   * History the components need = the LONGEST of the three lookbacks. Capping at `spanB` (the
   * longest under the 9/26/52 defaults, but not in general) made `mid(n)` slice from a negative
   * start for any `conversion`/`base` larger than it — `slice(-k)` returns the last k bars, so
   * `{ conversion: 60, spanB: 52 }` silently computed the conversion line over the last 8 bars and
   * reported a clean, wrong number.
   */
  private readonly capacity: number;
  constructor(parameters: {
    conv: number;
    basePeriod: number;
    spanBPeriod: number;
    displacement: number;
  }) {
    requireStreamParameters('IchimokuStream.constructor#0', 'IchimokuStream', parameters);
    const { conv, basePeriod, spanBPeriod, displacement } = parameters;
    this.conv = conv;
    this.basePeriod = basePeriod;
    this.spanBPeriod = spanBPeriod;
    this.displacement = displacement;
    this.capacity = Math.max(conv, basePeriod, spanBPeriod);
  }
  private mid(n: number): number {
    const length = this.highs.length;
    const h = maxOf(this.highs.slice(length - n));
    const l = minOf(this.lows.slice(length - n));
    return (h + l) / 2;
  }
  next(bar: BarInput): IchimokuPoint | null {
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.capacity) {
      this.highs.shift();
      this.lows.shift();
    }
    // Every component must have its full lookback before the record is real (warmup is the longest
    // of them; with the 9/26/52 defaults that is `spanB`, exactly as before).
    if (this.highs.length < this.capacity) {
      this.value = null;
      return null;
    }
    const tenkan = this.mid(this.conv);
    const kijun = this.mid(this.basePeriod);
    this.value = {
      tenkan,
      kijun,
      senkouA: (tenkan + kijun) / 2,
      senkouB: this.mid(this.spanBPeriod),
      chikou: bar.close,
      displacement: this.displacement,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ichimoku', {
      conv: this.conv,
      basePeriod: this.basePeriod,
      spanBPeriod: this.spanBPeriod,
      displacement: this.displacement,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): IchimokuStream {
    const state = readSnapshot(snapshot, 'ichimoku');
    const x = new IchimokuStream({
      conv: state.number('conv'),
      basePeriod: state.lookback('basePeriod'),
      spanBPeriod: state.lookback('spanBPeriod'),
      displacement: state.number('displacement'),
    });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<IchimokuPoint>('value');
    return x;
  }
}

export const ichimoku = makeIndicator<IchimokuParameters, BarInput, IchimokuPoint>(
  (p) =>
    new IchimokuStream({
      conv: requirePeriod(p.conversion ?? 9, 'ichimoku', 'conversion'),
      basePeriod: requirePeriod(p.base ?? 26, 'ichimoku', 'base'),
      spanBPeriod: requirePeriod(p.spanB ?? 52, 'ichimoku', 'spanB'),
      displacement: requirePeriod(p.displacement ?? 26, 'ichimoku', 'displacement'),
    }),
  IchimokuStream.fromJSON,
  () => ({ tenkan: NaN, kijun: NaN, senkouA: NaN, senkouB: NaN, chikou: NaN, displacement: NaN }),
);

// ───────────────────────── Vortex ─────────────────────────

export interface VortexPoint {
  viPlus: number;
  viMinus: number;
}

class VortexStream implements IndicatorStream<BarInput, VortexPoint> {
  private prevHigh: number | null = null;
  private prevLow = 0;
  private previousClose = 0;
  private vmP: number[] = [];
  private vmM: number[] = [];
  private trs: number[] = [];
  private sumP = 0;
  private sumM = 0;
  private sumTr = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: VortexPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'VortexStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): VortexPoint | null {
    if (this.prevHigh === null) {
      this.prevHigh = bar.high;
      this.prevLow = bar.low;
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const vmP = Math.abs(bar.high - this.prevLow);
    const vmM = Math.abs(bar.low - this.prevHigh);
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - this.previousClose),
      Math.abs(bar.low - this.previousClose),
    );
    this.prevHigh = bar.high;
    this.prevLow = bar.low;
    this.previousClose = bar.close;
    this.vmP.push(vmP);
    this.vmM.push(vmM);
    this.trs.push(tr);
    // Interior-NaN policy: only finite samples enter the running sums, and a dirty window emits NaN.
    if (isDirtySample(vmP) || isDirtySample(vmM) || isDirtySample(tr)) this.nanCount++;
    else {
      this.sumP += vmP;
      this.sumM += vmM;
      this.sumTr += tr;
    }
    if (this.vmP.length > this.period) {
      const goneP = this.vmP.shift()!;
      const goneM = this.vmM.shift()!;
      const goneTr = this.trs.shift()!;
      if (isDirtySample(goneP) || isDirtySample(goneM) || isDirtySample(goneTr)) this.nanCount--;
      else {
        this.sumP -= goneP;
        this.sumM -= goneM;
        this.sumTr -= goneTr;
      }
    }
    if (this.vmP.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = { viPlus: NaN, viMinus: NaN };
      return this.value;
    }
    this.value = {
      viPlus: this.sumTr === 0 ? 0 : this.sumP / this.sumTr,
      viMinus: this.sumTr === 0 ? 0 : this.sumM / this.sumTr,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vortex', {
      period: this.period,
      prevHigh: this.prevHigh,
      prevLow: this.prevLow,
      previousClose: this.previousClose,
      vmP: [...this.vmP],
      vmM: [...this.vmM],
      trs: [...this.trs],
      sumP: this.sumP,
      sumM: this.sumM,
      sumTr: this.sumTr,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VortexStream {
    const state = readSnapshot(snapshot, 'vortex');
    const x = new VortexStream(state.lookback('period'));
    Object.assign(x, {
      prevHigh: state.numberOrNull('prevHigh'),
      prevLow: state.number('prevLow'),
      previousClose: state.number('previousClose'),
      sumP: state.number('sumP'),
      sumM: state.number('sumM'),
      sumTr: state.number('sumTr'),
    });
    x.vmP = state.numbers('vmP');
    x.vmM = state.numbers('vmM');
    x.trs = state.numbers('trs');
    // The gate is derived from the restored window, so no snapshot key (or version bump) is needed.
    x.nanCount = dirtyRows(x.vmP, x.vmM, x.trs);
    x.value = state.cached<VortexPoint>('value');
    return x;
  }
}

export const vortex = makeIndicator<{ period?: number }, BarInput, VortexPoint>(
  (p) => new VortexStream(requirePeriod(p.period ?? 14, 'vortex')),
  VortexStream.fromJSON,
  () => ({ viPlus: NaN, viMinus: NaN }),
  { period: 14 },
);

// ───────────────────────── Linear regression / TSF ─────────────────────────

export interface LinregPoint {
  value: number;
  slope: number;
  intercept: number;
  angle: number;
  forecast: number;
}

class LinregStream implements IndicatorStream<number, LinregPoint> {
  private buf: number[] = [];
  private readonly sumX: number;
  private readonly sumX2: number;
  private readonly denom: number;
  value: LinregPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'LinregStream');
    const n = period;
    this.sumX = (n * (n - 1)) / 2;
    this.sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
    this.denom = n * this.sumX2 - this.sumX * this.sumX;
  }
  next(value: number): LinregPoint | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    const n = this.period;
    let sumY = 0;
    let sumXY = 0;
    for (let i = 0; i < n; i++) {
      sumY += this.buf[i]!;
      sumXY += i * this.buf[i]!;
    }
    const slope = this.denom === 0 ? 0 : (n * sumXY - this.sumX * sumY) / this.denom;
    const intercept = (sumY - slope * this.sumX) / n;
    this.value = {
      value: intercept + slope * (n - 1),
      slope,
      intercept,
      angle: (Math.atan(slope) * 180) / Math.PI,
      forecast: intercept + slope * n,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('linreg', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LinregStream {
    const state = readSnapshot(snapshot, 'linreg');
    const x = new LinregStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<LinregPoint>('value');
    return x;
  }
}

export const linreg = makeIndicator<PeriodParameters, number, LinregPoint>(
  (p) => new LinregStream(requirePeriod(p.period, 'linreg')),
  LinregStream.fromJSON,
  () => ({ value: NaN, slope: NaN, intercept: NaN, angle: NaN, forecast: NaN }),
);
export const linregSlope = projected<PeriodParameters, number, LinregPoint>(
  'linregSlope',
  (p) => new LinregStream(requirePeriod(p.period, 'linreg')),
  LinregStream.fromJSON,
  'slope',
);
export const linregIntercept = projected<PeriodParameters, number, LinregPoint>(
  'linregIntercept',
  (p) => new LinregStream(requirePeriod(p.period, 'linreg')),
  LinregStream.fromJSON,
  'intercept',
);
export const linregAngle = projected<PeriodParameters, number, LinregPoint>(
  'linregAngle',
  (p) => new LinregStream(requirePeriod(p.period, 'linreg')),
  LinregStream.fromJSON,
  'angle',
);
export const tsf = projected<PeriodParameters, number, LinregPoint>(
  'tsf',
  (p) => new LinregStream(requirePeriod(p.period, 'linreg')),
  LinregStream.fromJSON,
  'forecast',
);

// ───────────────────────── Chandelier exits ─────────────────────────

export interface ChandelierParameters {
  period: number;
  multiplier?: number;
}
export interface ChandelierPoint {
  long: number;
  short: number;
}

class ChandelierStream implements IndicatorStream<BarInput, ChandelierPoint> {
  private atr: AtrStream;
  private highs: number[] = [];
  private lows: number[] = [];
  value: ChandelierPoint | null = null;
  private readonly period: number;
  private readonly mult: number;
  constructor(parameters: { period: number; mult: number }) {
    requireStreamParameters('ChandelierStream.constructor#0', 'ChandelierStream', parameters);
    const { period, mult } = parameters;
    this.period = period;
    this.mult = mult;

    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): ChandelierPoint | null {
    const atr = this.atr.next(bar);
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.period) {
      this.highs.shift();
      this.lows.shift();
    }
    if (atr === null || this.highs.length < this.period) {
      this.value = null;
      return null;
    }
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    this.value = { long: hh - this.mult * atr, short: ll + this.mult * atr };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('chandelier', {
      period: this.period,
      mult: this.mult,
      atr: this.atr.toJSON(),
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ChandelierStream {
    const state = readSnapshot(snapshot, 'chandelier');
    const x = new ChandelierStream({
      period: state.lookback('period'),
      mult: state.number('mult'),
    });
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<ChandelierPoint>('value');
    return x;
  }
}

export const chandelierExit = makeIndicator<ChandelierParameters, BarInput, ChandelierPoint>(
  (p) =>
    new ChandelierStream({
      period: requirePeriod(p.period, 'chandelierExit', 'period', 1, 'bars'),
      mult: requirePositive(p.multiplier ?? 3, 'chandelierExit', 'multiplier'),
    }),
  ChandelierStream.fromJSON,
  () => ({ long: NaN, short: NaN }),
);

// ───────────────────────── ZigZag (batch; final leg provisional) ─────────────────────────

export interface ZigZagParameters {
  /** Minimum reversal as a percentage of price (e.g. 5 = 5%). */
  deviation: number;
}
const ZIGZAG_KEYS = ['deviation'] as const;
export interface ZigZagPivot {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

/** ZigZag report (Law 2): the pivot list plus the applied conventions and diagnostics. */
export interface ZigZagReport {
  pivots: ZigZagPivot[];
  /** The last pivot is provisional — a larger move can still extend the final leg. */
  provisional: boolean;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; deviation: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * ZigZag pivots: alternating swing highs and lows that each reverse price by at least `deviation`%.
 * The last pivot is provisional — a larger move can still extend the final leg — so it is flagged via
 * `provisional`. ZigZag repaints by nature; it is a batch utility, not a streaming indicator.
 */
export function zigzag(bars: ArrayLike<BarInput>, parameters: ZigZagParameters): ZigZagReport {
  requireArgumentArray('zigzag', 'bars', bars);
  requireBars(bars, 'zigzag');
  requireArgumentObject('zigzag', 'parameters', parameters);
  // Law 12: an unknown param (a `devation` typo) teaches instead of being silently ignored.
  ensureKnownKeys('zigzag', 'parameters', parameters, ZIGZAG_KEYS);
  const deviation = requirePositive(parameters.deviation, 'zigzag', 'deviation', 'bars');
  const report = (pivots: ZigZagPivot[], provisional: boolean): ZigZagReport => ({
    pivots,
    provisional,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, deviation },
    diagnostics: { warnings: [] },
  });
  const pivots: ZigZagPivot[] = [];
  if (bars.length === 0) return report(pivots, false);
  const thr = deviation / 100;
  let dir: 0 | 1 | -1 = 0; // 0 unknown, 1 seeking a swing high, −1 seeking a swing low
  let extremeIdx = 0;
  let extremeHigh = bars[0]!.high;
  let extremeLow = bars[0]!.low;
  let extremeHighIdx = 0;
  let extremeLowIdx = 0;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (dir === 0) {
      // anchor running high & low from bar 0; the first confirmed pivot is whichever extreme
      // price retraces away from by at least the threshold
      if (b.high >= extremeHigh) {
        extremeHigh = b.high;
        extremeHighIdx = i;
      }
      if (b.low <= extremeLow) {
        extremeLow = b.low;
        extremeLowIdx = i;
      }
      if (b.low <= extremeHigh * (1 - thr)) {
        pivots.push({ index: extremeHighIdx, price: extremeHigh, kind: 'high' });
        dir = -1;
        extremeLow = b.low;
        extremeIdx = i;
      } else if (b.high >= extremeLow * (1 + thr)) {
        pivots.push({ index: extremeLowIdx, price: extremeLow, kind: 'low' });
        dir = 1;
        extremeHigh = b.high;
        extremeIdx = i;
      }
    } else if (dir === 1) {
      // seeking a swing high: track the running high, confirm it on a downward reversal
      if (b.high >= extremeHigh) {
        extremeHigh = b.high;
        extremeIdx = i;
      }
      if (b.low <= extremeHigh * (1 - thr)) {
        pivots.push({ index: extremeIdx, price: extremeHigh, kind: 'high' });
        dir = -1;
        extremeLow = b.low;
        extremeIdx = i;
      }
    } else {
      // seeking a swing low: track the running low, confirm it on an upward reversal
      if (b.low <= extremeLow) {
        extremeLow = b.low;
        extremeIdx = i;
      }
      if (b.high >= extremeLow * (1 + thr)) {
        pivots.push({ index: extremeIdx, price: extremeLow, kind: 'low' });
        dir = 1;
        extremeHigh = b.high;
        extremeIdx = i;
      }
    }
  }
  // close out with the provisional final extreme
  let provisional = false;
  if (dir === 1) {
    pivots.push({ index: extremeIdx, price: extremeHigh, kind: 'high' });
    provisional = true;
  } else if (dir === -1) {
    pivots.push({ index: extremeIdx, price: extremeLow, kind: 'low' });
    provisional = true;
  }
  return report(pivots, provisional);
}

export {
  DmiStream,
  AdxrStream,
  AroonStream,
  PsarStream,
  PsarExtStream,
  DonchianTrendStream,
  SupertrendStream,
  IchimokuStream,
  VortexStream,
  LinregStream,
  ChandelierStream,
};

export * from './trend-ext.js';
