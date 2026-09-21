/**
 * Hilbert-transform cycle indicators (spec §13.3; TA-Lib `HT_*` family).
 *
 * `htDcPeriod`, `htDcPhase`, `htPhasor`, `htSine`, `htTrendMode`, `htTrendline` — all derived from a
 * shared Ehlers Hilbert-transform core (the same machinery proven in MAMA/FAMA). These follow Ehlers'
 * published Hilbert formulation and TA-Lib's dominant-cycle-phase computation; they are *not*
 * bit-exact TA-Lib (the `HT_*` C kernels carry implementation-specific smoothing), and like MAMA the
 * adaptive period needs a warm-up before it stabilizes. Inputs are a single price series (the close,
 * matching TA-Lib's `real` argument).
 */

import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { EmaStream } from './moving-averages.js';
import { requirePeriod } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

function pushRing(ring: number[], v: number, length: number): void {
  ring.unshift(v);
  if (ring.length > length) ring.pop();
}
function at(ring: number[], i: number): number {
  return ring[i] ?? 0;
}

export interface HilbertOut {
  /** Dominant cycle period (smoothed), clamped to [6, 50]. */
  dcPeriod: number;
  /** In-phase component. */
  inPhase: number;
  /** Quadrature component. */
  quadrature: number;
  /** Dominant cycle phase in degrees (TA-Lib DCPhase algorithm). */
  dcPhase: number;
  /** Instantaneous trendline (dominant-cycle SMA of price, 4-3-2-1 smoothed). */
  trendline: number;
}

/** Shared Ehlers Hilbert-transform discriminator. Emits once the FIR history has filled (~6 bars). */
export class HilbertCore {
  private count = 0;
  private price: number[] = []; // up to 50 bars (index 0 = newest)
  private smooth: number[] = []; // up to 50 bars
  private detrender: number[] = [];
  private i1: number[] = [];
  private q1: number[] = [];
  private i2 = 0;
  private q2 = 0;
  private re = 0;
  private im = 0;
  private period = 0;
  private smoothPeriod = 0;
  private tlr: number[] = []; // raw trendline history (for 4-3-2-1 smoothing), up to 4

  update(priceValue: number): HilbertOut | null {
    pushRing(this.price, priceValue, 50);
    this.count++;
    if (this.count <= 6) {
      pushRing(this.smooth, priceValue, 50);
      pushRing(this.detrender, 0, 8);
      pushRing(this.i1, 0, 8);
      pushRing(this.q1, 0, 8);
      return null;
    }
    const adj = 0.075 * this.period + 0.54;
    const smooth =
      (4 * at(this.price, 0) + 3 * at(this.price, 1) + 2 * at(this.price, 2) + at(this.price, 3)) /
      10;
    pushRing(this.smooth, smooth, 50);
    const detrender =
      (0.0962 * at(this.smooth, 0) +
        0.5769 * at(this.smooth, 2) -
        0.5769 * at(this.smooth, 4) -
        0.0962 * at(this.smooth, 6)) *
      adj;
    pushRing(this.detrender, detrender, 8);

    const q1 =
      (0.0962 * at(this.detrender, 0) +
        0.5769 * at(this.detrender, 2) -
        0.5769 * at(this.detrender, 4) -
        0.0962 * at(this.detrender, 6)) *
      adj;
    const i1 = at(this.detrender, 3);
    pushRing(this.q1, q1, 8);
    pushRing(this.i1, i1, 8);

    const jI =
      (0.0962 * at(this.i1, 0) +
        0.5769 * at(this.i1, 2) -
        0.5769 * at(this.i1, 4) -
        0.0962 * at(this.i1, 6)) *
      adj;
    const jQ =
      (0.0962 * at(this.q1, 0) +
        0.5769 * at(this.q1, 2) -
        0.5769 * at(this.q1, 4) -
        0.0962 * at(this.q1, 6)) *
      adj;

    let i2 = i1 - jQ;
    let q2 = q1 + jI;
    i2 = 0.2 * i2 + 0.8 * this.i2;
    q2 = 0.2 * q2 + 0.8 * this.q2;
    let re = i2 * this.i2 + q2 * this.q2;
    let im = i2 * this.q2 - q2 * this.i2;
    re = 0.2 * re + 0.8 * this.re;
    im = 0.2 * im + 0.8 * this.im;
    this.i2 = i2;
    this.q2 = q2;
    this.re = re;
    this.im = im;

    const prevPeriod = this.period;
    let period = prevPeriod;
    if (im !== 0 && re !== 0) period = 360 / (RAD2DEG * Math.atan(im / re));
    if (prevPeriod > 0) {
      if (period > 1.5 * prevPeriod) period = 1.5 * prevPeriod;
      if (period < 0.67 * prevPeriod) period = 0.67 * prevPeriod;
    }
    if (period < 6) period = 6;
    if (period > 50) period = 50;
    period = 0.2 * period + 0.8 * prevPeriod;
    this.period = period;
    this.smoothPeriod = 0.33 * period + 0.67 * this.smoothPeriod;

    // DCPhase (TA-Lib algorithm): accumulate the smoothed price over the dominant cycle.
    const dcLen = Math.max(1, Math.round(this.smoothPeriod));
    let realPart = 0;
    let imagPart = 0;
    for (let i = 0; i < dcLen; i++) {
      const ang = (2 * Math.PI * i) / dcLen;
      const s = at(this.smooth, i);
      realPart += Math.sin(ang) * s;
      imagPart += Math.cos(ang) * s;
    }
    let dcPhase: number;
    if (Math.abs(imagPart) > 0) dcPhase = Math.atan(realPart / imagPart) * RAD2DEG;
    else dcPhase = realPart > 0 ? 90 : -90;
    dcPhase += 90;
    dcPhase += 360 / this.smoothPeriod;
    if (imagPart < 0) dcPhase += 180;
    if (dcPhase > 315) dcPhase -= 360;

    // Instantaneous trendline: dominant-cycle SMA of price, then 4-3-2-1 smoothing.
    let sum = 0;
    for (let i = 0; i < dcLen; i++) sum += at(this.price, i);
    const tlr = sum / dcLen;
    pushRing(this.tlr, tlr, 4);
    const trendline =
      (4 * at(this.tlr, 0) + 3 * at(this.tlr, 1) + 2 * at(this.tlr, 2) + at(this.tlr, 3)) / 10;

    return { dcPeriod: this.smoothPeriod, inPhase: i1, quadrature: q1, dcPhase, trendline };
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('hilbert', {
      count: this.count,
      price: [...this.price],
      smooth: [...this.smooth],
      detrender: [...this.detrender],
      i1: [...this.i1],
      q1: [...this.q1],
      i2: this.i2,
      q2: this.q2,
      re: this.re,
      im: this.im,
      period: this.period,
      smoothPeriod: this.smoothPeriod,
      tlr: [...this.tlr],
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HilbertCore {
    const state = readSnapshot(snapshot, 'hilbert');
    const x = new HilbertCore();
    Object.assign(x, {
      count: state.number('count'),
      i2: state.number('i2'),
      q2: state.number('q2'),
      re: state.number('re'),
      im: state.number('im'),
      period: state.number('period'),
      smoothPeriod: state.number('smoothPeriod'),
    });
    x.price = state.numbers('price');
    x.smooth = state.numbers('smooth');
    x.detrender = state.numbers('detrender');
    x.i1 = state.numbers('i1');
    x.q1 = state.numbers('q1');
    x.tlr = state.numbers('tlr');
    return x;
  }
}

type Empty = Record<never, never>;

// ───────────────────────── pandas-ta cycle additions ─────────────────────────

export interface DspParameters {
  period?: number;
}

class DspStream implements IndicatorStream<number, number> {
  private ema: EmaStream;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'DspStream');
    this.ema = new EmaStream(period);
  }
  next(value: number): number | null {
    const e = this.ema.next(value);
    if (e === null) {
      this.value = null;
      return null;
    }
    this.value = value - e;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('dsp', { period: this.period, ema: this.ema.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DspStream {
    const state = readSnapshot(snapshot, 'dsp');
    const x = new DspStream(state.lookback('period'));
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Detrended Synthetic Price: `close - EMA(close, period)` (pandas-ta `dsp`). */
export const dsp = makeIndicator<DspParameters, number, number>(
  (p) => new DspStream(requirePeriod(p.period ?? 14, 'dsp')),
  DspStream.fromJSON,
  () => NaN,
);

export interface EbswParameters {
  /** Max cycle/trend period. pandas-ta enforces a practical minimum of 39. Default 40. */
  period?: number;
  /** Low-pass filtering period. Default 10. */
  bars?: number;
}

/**
 * Even Better Sinewave — **pandas-ta-compatible, including pandas-ta's degree/radian defect.**
 *
 * pandas-ta's `ebsw` feeds `360 / period` (and `√2·180 / bars`) to `sin`/`cos`, which take RADIANS,
 * so the high-pass and super-smoother coefficients are not the ones Ehlers published (his use
 * `2π / period` and `√2·π / bars`). TotalFinance reproduces pandas-ta bit-for-bit — that is what the
 * certified golden pins and what a pandas-ta user comparing outputs expects — which means **this is
 * not Ehlers's published filter**. Treat `ebsw` as "pandas-ta's EBSW", and do not port its
 * coefficients to a from-scratch Ehlers implementation.
 */
class EbswStream implements IndicatorStream<number, number> {
  private count = 0;
  private lastClose = 0;
  private lastHp = 0;
  private filt0 = 0;
  private filt1 = 0;
  value: number | null = null;
  private readonly period: number;
  private readonly bars: number;
  constructor(parameters: { period: number; bars: number }) {
    requireStreamParameters('EbswStream.constructor#0', 'EbswStream', parameters);
    const { period, bars } = parameters;
    this.period = period;
    this.bars = bars;
  }
  next(value: number): number | null {
    this.count++;
    if (this.count < this.period) {
      this.value = null;
      return null;
    }
    if (this.count === this.period) {
      this.value = 0;
      return this.value;
    }
    // DELIBERATE BUG-COMPATIBILITY (see the class docstring): `360 / period` is a DEGREE quantity
    // handed to a radian trig function, exactly as pandas-ta does it. Ehlers' published filter uses
    // `sin/cos(2π / period)`. Changing it here would break the certified pandas-ta golden.
    const alpha = (1 - Math.sin(360 / this.period)) / Math.cos(360 / this.period);
    const hp = 0.5 * (1 + alpha) * (value - this.lastClose) + alpha * this.lastHp;
    const a1 = Math.exp((-Math.SQRT2 * Math.PI) / this.bars);
    const b1 = 2 * a1 * Math.cos((Math.SQRT2 * 180) / this.bars);
    const c2 = b1;
    const c3 = -a1 * a1;
    const c1 = 1 - c2 - c3;
    const filt = (c1 * (hp + this.lastHp)) / 2 + c2 * this.filt1 + c3 * this.filt0;
    const wave = (filt + this.filt1 + this.filt0) / 3;
    const power = (filt * filt + this.filt1 * this.filt1 + this.filt0 * this.filt0) / 3;
    this.value = power > 0 ? wave / Math.sqrt(power) : 0;
    this.filt0 = this.filt1;
    this.filt1 = filt;
    this.lastHp = hp;
    this.lastClose = value;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ebsw', {
      period: this.period,
      bars: this.bars,
      count: this.count,
      lastClose: this.lastClose,
      lastHp: this.lastHp,
      filt0: this.filt0,
      filt1: this.filt1,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): EbswStream {
    const state = readSnapshot(snapshot, 'ebsw');
    const x = new EbswStream({
      period: state.lookback('period'),
      bars: state.number('bars'),
    });
    x.count = state.number('count');
    x.lastClose = state.number('lastClose');
    x.lastHp = state.number('lastHp');
    x.filt0 = state.number('filt0');
    x.filt1 = state.number('filt1');
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * Even Better Sinewave (pandas-ta `ebsw`), bounded roughly to [-1, 1].
 *
 * Matches pandas-ta **including its degree/radian translation defect** — it is not Ehlers's published
 * filter (see `EbswStream` and `docs/compatibility/talib-differences.md`).
 */
export const ebsw = makeIndicator<EbswParameters, number, number>(
  (p) =>
    new EbswStream({
      period: requirePeriod(p.period ?? 40, 'ebsw', 'period', 39),
      bars: requirePeriod(p.bars ?? 10, 'ebsw', 'bars'),
    }),
  EbswStream.fromJSON,
  () => NaN,
);

export interface MswParameters {
  period?: number;
}
export interface MswPoint {
  sine: number;
  lead: number;
}

class MswStream implements IndicatorStream<number, MswPoint> {
  private buf: number[] = [];
  private count = 0;
  private readonly cos: number[];
  private readonly sin: number[];
  value: MswPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MswStream', 'period', 2);
    this.cos = Array.from({ length: period }, (_, j) => Math.cos((2 * Math.PI * j) / period));
    this.sin = Array.from({ length: period }, (_, j) => Math.sin((2 * Math.PI * j) / period));
  }
  next(value: number): MswPoint | null {
    this.buf.unshift(value);
    if (this.buf.length > this.period) this.buf.pop();
    this.count++;
    // Warmup is `period` bars (first value at index `period`), matching tulipy/Tulip Indicators —
    // not `period − 1`, which would shift every downstream cycle signal one bar early.
    if (this.count <= this.period) {
      this.value = null;
      return null;
    }
    let real = 0;
    let imag = 0;
    for (let j = 0; j < this.period; j++) {
      real += this.buf[j]! * this.cos[j]!;
      imag += this.buf[j]! * this.sin[j]!;
    }
    let phase =
      Math.abs(real) > 0.001 ? Math.atan(imag / real) : (Math.PI / 2) * (imag < 0 ? -1 : 1);
    if (real < 0) phase += Math.PI;
    phase += Math.PI / 2;
    if (phase < 0) phase += 2 * Math.PI;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    this.value = { sine: Math.sin(phase), lead: Math.sin(phase + Math.PI / 4) };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('msw', {
      period: this.period,
      count: this.count,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MswStream {
    const state = readSnapshot(snapshot, 'msw');
    const x = new MswStream(state.lookback('period'));
    x.count = state.number('count') ?? state.numbers('buf').length;
    x.buf = state.numbers('buf');
    x.value = state.cached<MswPoint>('value');
    return x;
  }
}

/** Mesa Sine Wave (pandas-ta/tulipy `msw`). */
export const msw = makeIndicator<MswParameters, number, MswPoint>(
  (p) => new MswStream(requirePeriod(p.period ?? 5, 'msw', 'period', 2)),
  MswStream.fromJSON,
  () => ({ sine: NaN, lead: NaN }),
);

// ───────────────────────── scalar HT facades ─────────────────────────

class HtScalarStream implements IndicatorStream<number, number> {
  core = new HilbertCore();
  value: number | null = null;
  private readonly kind: string;
  private readonly pick: (output: HilbertOut) => number;
  constructor(parameters: { kind: string; pick: (output: HilbertOut) => number }) {
    requireStreamParameters('HtScalarStream.constructor#0', 'HtScalarStream', parameters);
    const { kind, pick } = parameters;
    this.kind = kind;
    this.pick = pick;
  }
  next(value: number): number | null {
    const o = this.core.update(value);
    this.value = o ? this.pick(o) : null;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { core: this.core.toJSON(), value: this.value });
  }
}

function htScalar(kind: string, pick: (output: HilbertOut) => number) {
  return makeIndicator<Empty, number, number>(
    () => new HtScalarStream({ kind, pick }),
    (s) => {
      const state = readSnapshot(s, kind);
      const x = new HtScalarStream({ kind, pick });
      x.core = HilbertCore.fromJSON(state.child('core'));
      x.value = state.cached<number>('value');
      return x;
    },
    () => NaN,
  );
}

export const htDcPeriod = htScalar('htDcPeriod', (o) => o.dcPeriod);
export const htDcPhase = htScalar('htDcPhase', (o) => o.dcPhase);
export const htTrendline = htScalar('htTrendline', (o) => o.trendline);

// ───────────────────────── HT_PHASOR ─────────────────────────

export interface PhasorPoint {
  inPhase: number;
  quadrature: number;
}

class HtPhasorStream implements IndicatorStream<number, PhasorPoint> {
  core = new HilbertCore();
  value: PhasorPoint | null = null;
  next(value: number): PhasorPoint | null {
    const o = this.core.update(value);
    this.value = o ? { inPhase: o.inPhase, quadrature: o.quadrature } : null;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('htPhasor', { core: this.core.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HtPhasorStream {
    const state = readSnapshot(snapshot, 'htPhasor');
    const x = new HtPhasorStream();
    x.core = HilbertCore.fromJSON(state.child('core'));
    x.value = state.cached<PhasorPoint>('value');
    return x;
  }
}

export const htPhasor = makeIndicator<Empty, number, PhasorPoint>(
  () => new HtPhasorStream(),
  HtPhasorStream.fromJSON,
  () => ({ inPhase: NaN, quadrature: NaN }),
);

// ───────────────────────── HT_SINE ─────────────────────────

export interface SinePoint {
  sine: number;
  leadSine: number;
}

class HtSineStream implements IndicatorStream<number, SinePoint> {
  core = new HilbertCore();
  value: SinePoint | null = null;
  next(value: number): SinePoint | null {
    const o = this.core.update(value);
    this.value = o
      ? { sine: Math.sin(o.dcPhase * DEG2RAD), leadSine: Math.sin((o.dcPhase + 45) * DEG2RAD) }
      : null;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('htSine', { core: this.core.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HtSineStream {
    const state = readSnapshot(snapshot, 'htSine');
    const x = new HtSineStream();
    x.core = HilbertCore.fromJSON(state.child('core'));
    x.value = state.cached<SinePoint>('value');
    return x;
  }
}

export const htSine = makeIndicator<Empty, number, SinePoint>(
  () => new HtSineStream(),
  HtSineStream.fromJSON,
  () => ({ sine: NaN, leadSine: NaN }),
);

// ───────────────────────── HT_TRENDMODE ─────────────────────────

/**
 * 1 = trend, 0 = cycle. Cycle mode is entered on a sine/lead-sine crossing and held for roughly one
 * dominant cycle (an Ehlers-style heuristic; TA-Lib's exact trend test differs in detail).
 */
class HtTrendModeStream implements IndicatorStream<number, number> {
  core = new HilbertCore();
  private prevSine: number | null = null;
  private prevLead = 0;
  private cycleBars = 0;
  value: number | null = null;
  next(value: number): number | null {
    const o = this.core.update(value);
    if (!o) {
      this.value = null;
      return null;
    }
    const sine = Math.sin(o.dcPhase * DEG2RAD);
    const lead = Math.sin((o.dcPhase + 45) * DEG2RAD);
    if (this.prevSine !== null) {
      const crossed = sine > lead !== this.prevSine > this.prevLead;
      if (crossed) this.cycleBars = Math.max(1, Math.round(o.dcPeriod));
    }
    this.prevSine = sine;
    this.prevLead = lead;
    const mode = this.cycleBars > 0 ? 0 : 1;
    if (this.cycleBars > 0) this.cycleBars--;
    this.value = mode;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('htTrendMode', {
      core: this.core.toJSON(),
      prevSine: this.prevSine,
      prevLead: this.prevLead,
      cycleBars: this.cycleBars,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HtTrendModeStream {
    const state = readSnapshot(snapshot, 'htTrendMode');
    const x = new HtTrendModeStream();
    x.core = HilbertCore.fromJSON(state.child('core'));
    x.prevSine = state.numberOrNull('prevSine');
    x.prevLead = state.number('prevLead');
    x.cycleBars = state.number('cycleBars');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const htTrendMode = makeIndicator<Empty, number, number>(
  () => new HtTrendModeStream(),
  HtTrendModeStream.fromJSON,
  () => NaN,
);

export {
  DspStream,
  EbswStream,
  MswStream,
  HtScalarStream,
  HtPhasorStream,
  HtSineStream,
  HtTrendModeStream,
};
