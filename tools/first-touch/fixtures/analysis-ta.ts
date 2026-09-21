/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Covers the ta package's price-action reports (pivots/swings/structure/levels/gaps) and the
 * microstructure surface (aggressor classification, CVD, tick profile, order-book analytics).
 * Aliases (`technical_analysis.priceAction.*`) are the SAME functions and are covered by identity fallback.
 */

import { BARS, CLOSES, type FixtureThunk } from '../inputs.js';

// ── local input builders ─────────────────────────────────────────────────────────────────────────

/** Epoch-ms anchor for timestamped trades (an arbitrary fixed instant, for determinism). */
const T0 = 1_700_000_000_000;

/** A synthetic trade tape ({ price, size, time }) sharing the CLOSES() price path. */
const TRADES = (): Array<{ price: number; size: number; time: number }> =>
  CLOSES()
    .slice(0, 48)
    .map((price, i) => ({
      price: Math.round(price * 100) / 100,
      size: 5 + (i % 9),
      time: T0 + i * 500,
    }));

/** NBBO quotes aligned 1:1 with TRADES() (a 10-cent market straddling each print). */
const QUOTES = (): Array<{ bid: number; ask: number; bidSize: number; askSize: number }> =>
  TRADES().map((t, i) => ({
    bid: t.price - 0.05,
    ask: t.price + 0.05,
    bidSize: 40 + (i % 5) * 10,
    askSize: 35 + (i % 7) * 10,
  }));

/** A three-level order book, best-first (bids descending, asks ascending). */
const BOOK = (): {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
} => ({
  bids: [
    { price: 99.98, size: 120 },
    { price: 99.97, size: 80 },
    { price: 99.96, size: 40 },
  ],
  asks: [
    { price: 100.02, size: 90 },
    { price: 100.03, size: 70 },
    { price: 100.04, size: 55 },
  ],
});

/** The shared bars with real opening gaps injected (BARS() opens exactly at the prior close). */
const GAP_BARS = (): ReturnType<typeof BARS> => {
  const bars = BARS();
  for (const i of [12, 34, 56]) {
    const prev = bars[i - 1]!;
    const b = bars[i]!;
    b.open = prev.high + 1.2; // gap up over the prior high
    b.high = Math.max(b.high, b.open + 0.8);
  }
  for (const i of [22, 44]) {
    const prev = bars[i - 1]!;
    const b = bars[i]!;
    b.open = prev.low - 1.2; // gap down under the prior low
    b.low = Math.min(b.low, b.open - 0.8);
  }
  return bars;
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_TA_FIXTURES: Record<string, FixtureThunk> = {
  // Resource-bearing helpers that are not analysis-role exports still belong in the count ratchet.
  'technical-analysis.aggregators.tick': () => [3],
  'technical-analysis.lineBreak': () => [BARS(), { lines: 3 }],
  'technical-analysis.charts.lineBreak': () => [BARS(), { lines: 3 }],
  'technical-analysis.describeIndicator': () => ['rsi', 512],
  'technical-analysis.indicatorWarmup': () => ['rsi', 512],
  'technical-analysis.indicatorWarmups': () => [512],

  // snapshot envelope boundary (3B.N7). Positional by design: `snapshotOf` is the ONE place that
  // stamps `schemaVersion`, so it takes the kind and the opaque state and nothing else. The state
  // here is a realistic streaming-indicator payload rather than `{}`, so the probes exercise a
  // populated envelope.
  'technical-analysis.snapshotOf': () => ['ema', { period: 10, value: 101.25, count: 30 }],

  // The other half of the same boundary (3B.1): `readSnapshot` is the ONE door back in, so it takes
  // the envelope and the kind the calling restorer produces — the second argument IS the identity
  // guard, which is why it has no default. The envelope here is what `snapshotOf` above returns.
  'technical-analysis.readSnapshot': () => [
    { kind: 'ema', schemaVersion: 3, state: { period: 10, value: 101.25, count: 30 } },
    'ema',
  ],

  // price action (Law 2 reports)
  'technical-analysis.pivots': () => [
    { open: 100, high: 112, low: 96, close: 108, volume: 25_000 },
    'classic',
  ],
  'technical-analysis.swings': () => [BARS(), { strength: 2 }],
  'technical-analysis.fractals': () => [BARS()],
  'technical-analysis.supportResistance': () => [BARS(), { strength: 2, tolerance: 0.01 }],
  'technical-analysis.trendlines': () => [BARS(), { strength: 2 }],
  'technical-analysis.channel': () => [BARS(), { strength: 2 }],
  'technical-analysis.breakouts': () => [BARS(), { lookback: 20 }],
  'technical-analysis.gaps': () => [GAP_BARS(), { minSizeFraction: 0.005 }],
  'technical-analysis.gapFill': () => [GAP_BARS(), { minSizeFraction: 0.005 }],
  'technical-analysis.marketStructure': () => [BARS(), { strength: 2 }],

  // microstructure (Law 2 envelopes + reports)
  'technical-analysis.tradeSign': () => [
    { price: 100.03, size: 10, time: T0 },
    { quote: { bid: 100, ask: 100.04 }, previousPrice: 100.01, previousSign: 1 },
  ],
  'technical-analysis.cumulativeVolumeDelta': () => [
    TRADES(),
    { method: 'quote', quotes: QUOTES() },
  ],
  'technical-analysis.tickVolumeProfile': () => [
    TRADES(),
    { bins: 12, valueAreaFraction: 0.7, method: 'tick' },
  ],
  'technical-analysis.bookImbalance': () => [BOOK(), { levels: 2, weighted: true }],
  'technical-analysis.microprice': () => [BOOK()],
  'technical-analysis.orderBookImbalance': () => [{ bidSize: 300, askSize: 180 }],

  // volume (Law 2 report)
  'technical-analysis.volumeProfile': () => [BARS(), { bins: 16, valueAreaFraction: 0.7 }],
};
