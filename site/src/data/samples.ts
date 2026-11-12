/**
 * Deterministic SYNTHETIC sample datasets for the playgrounds. They are generated from a fixed seed,
 * rounded to cents, and labelled as synthetic everywhere they appear. They are not market history
 * and never stand in for it; readers bring their own data for real analysis.
 */
import type { DataSample, OhlcvBar } from '../types';

/** mulberry32: a tiny, well-known deterministic PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms (Box–Muller). */
function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Weekday session labels starting at `start`. Synthetic sessions, not an exchange calendar. */
export function weekdaySessions(start: string, count: number): string[] {
  const dates: string[] = [];
  const day = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

export interface RegimeSpec {
  sessions: number;
  /** Daily drift (decimal). */
  drift: number;
  /** Daily volatility (decimal). */
  volatility: number;
}

export function syntheticBars(seed: number, start: number, regimes: RegimeSpec[]): OhlcvBar[] {
  const next = random(seed);
  const total = regimes.reduce((count, regime) => count + regime.sessions, 0);
  const dates = weekdaySessions('2025-01-02', total);
  const bars: OhlcvBar[] = [];
  let close = start;
  for (const regime of regimes)
    for (let index = 0; index < regime.sessions; index += 1) {
      const open = cents(close * (1 + normal(next) * regime.volatility * 0.25));
      const nextClose = cents(
        Math.max(1, close * Math.exp(regime.drift + normal(next) * regime.volatility)),
      );
      const range = Math.abs(normal(next)) * regime.volatility * 0.6 + regime.volatility * 0.2;
      const high = cents(Math.max(open, nextClose) * (1 + range * next()));
      const low = cents(Math.min(open, nextClose) * (1 - range * next()));
      const volume = Math.round(
        800_000 * (1 + Math.abs(normal(next)) * 0.8 + (Math.abs(nextClose - close) / close) * 20),
      );
      bars.push({ date: dates[bars.length]!, open, high, low, close: nextClose, volume });
      close = nextClose;
    }
  return bars;
}

export const OHLCV_SAMPLES: DataSample[] = [
  {
    id: 'trend',
    label: 'Synthetic uptrend with pullbacks',
    description: '250 synthetic weekday sessions: a steady advance interrupted by two corrections.',
    value: {
      format: 'ohlcv',
      label: 'Synthetic uptrend with pullbacks (seed 7, not market data)',
      origin: 'sample',
      bars: syntheticBars(7, 100, [
        { sessions: 80, drift: 0.0012, volatility: 0.012 },
        { sessions: 25, drift: -0.003, volatility: 0.018 },
        { sessions: 90, drift: 0.0015, volatility: 0.011 },
        { sessions: 20, drift: -0.004, volatility: 0.022 },
        { sessions: 35, drift: 0.002, volatility: 0.013 },
      ]),
    },
  },
  {
    id: 'range',
    label: 'Synthetic range-bound market',
    description: '250 synthetic weekday sessions oscillating without a durable trend.',
    value: {
      format: 'ohlcv',
      label: 'Synthetic range-bound market (seed 21, not market data)',
      origin: 'sample',
      bars: syntheticBars(21, 50, [
        { sessions: 60, drift: 0.0015, volatility: 0.014 },
        { sessions: 60, drift: -0.0016, volatility: 0.014 },
        { sessions: 65, drift: 0.0014, volatility: 0.015 },
        { sessions: 65, drift: -0.0012, volatility: 0.014 },
      ]),
    },
  },
  {
    id: 'shock',
    label: 'Synthetic volatility shock',
    description: '250 synthetic weekday sessions with a sharp drawdown and recovery.',
    value: {
      format: 'ohlcv',
      label: 'Synthetic volatility shock (seed 99, not market data)',
      origin: 'sample',
      bars: syntheticBars(99, 220, [
        { sessions: 120, drift: 0.0008, volatility: 0.009 },
        { sessions: 15, drift: -0.012, volatility: 0.035 },
        { sessions: 115, drift: 0.0016, volatility: 0.016 },
      ]),
    },
  },
];

/** Daily simple returns from a sample's closes, rounded to 1e-6 (a decimal fraction per session). */
export function closesToReturns(bars: readonly OhlcvBar[]): number[] {
  return bars
    .slice(1)
    .map((bar, index) => Math.round((bar.close / bars[index]!.close - 1) * 1e6) / 1e6);
}

export const RETURN_SAMPLES: DataSample[] = OHLCV_SAMPLES.map((sample) => {
  if (sample.value.format !== 'ohlcv') throw new Error('Expected OHLCV sample.');
  const bars = sample.value.bars;
  return {
    id: sample.id,
    label: sample.label.replace('Synthetic', 'Synthetic returns:'),
    description: `${bars.length - 1} daily simple returns from the ${sample.label.toLowerCase()} sample.`,
    value: {
      format: 'series',
      label: `${sample.value.label}, daily simple returns`,
      origin: 'sample',
      meaning: 'returns',
      values: closesToReturns(bars),
      dates: bars.slice(1).map((bar) => bar.date),
    },
  };
});

/** Every sample by id. Samples are regenerated from code, so pages ship ids, not data. */
export const SAMPLE_REGISTRY: ReadonlyMap<string, DataSample> = new Map(
  [
    ...OHLCV_SAMPLES.map((sample) => ['ohlcv', sample] as const),
    ...RETURN_SAMPLES.map((sample) => ['series', sample] as const),
  ].map(([format, sample]) => [`${format}:${sample.id}`, sample]),
);
