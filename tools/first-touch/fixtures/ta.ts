/**
 * Deep-sweep fixture shard — see ../fixtures.ts for the contract. Keys are sweep paths; thunks
 * return FRESH valid argument lists (probes mutate arguments).
 *
 * Covers the ta package's non-registry callables: the candlestick catalog and its TA-Lib engines,
 * chart-type / information-driven bar aggregations, price-action batch utilities, the signal DSL
 * builders, multi-timeframe resampling/alignment, and the async streaming adapters.
 */

import { sma } from '@totalfinance/technical-analysis';
import { BARS, CLOSES, type FixtureThunk } from '../inputs.js';

// ── local input builders ─────────────────────────────────────────────────────────────────────────

/** Epoch-ms anchor for timestamped bars/trades (an arbitrary fixed instant, for determinism). */
const T0 = 1_700_000_000_000;

interface TimeBarFixture {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** `count` timestamped bars `stepMs` apart (ascending ts), reusing the shared OHLCV shapes. */
const timeBars = (count: number, stepMs: number): TimeBarFixture[] =>
  BARS()
    .slice(0, count)
    .map((b, i) => ({ ...b, timestampMs: T0 + i * stepMs }));

/** A small synthetic trade tape ({ price, size, time }) for the tape-consuming aggregators. */
const trades = (): Array<{ price: number; size: number; time: number }> =>
  CLOSES()
    .slice(0, 40)
    .map((price, i) => ({ price, size: 10 + (i % 7), time: T0 + i * 1_000 }));

/** Session ids grouping the first 24 shared bars into 3 sessions of 8 (bars carry no timestamp). */
const sessionIds = (): number[] => Array.from({ length: 24 }, (_, i) => Math.floor(i / 8));

/** A second series diverging from CLOSES(), for pair/divergence inputs. */
const counterSeries = (): number[] => CLOSES().map((v, i) => v + Math.cos(i / 3) * 2);

/** A fresh async source of a few closes, for the async streaming adapters. */
async function* asyncCloses(): AsyncGenerator<number> {
  for (const v of CLOSES().slice(0, 8)) yield v;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

export const TA_FIXTURES: Record<string, FixtureThunk> = {
  // chart types & information-driven bars: (bars, parameters)
  'technical-analysis.renko': () => [BARS(), { brickSize: 2 }],
  'technical-analysis.kagi': () => [BARS(), { reversal: 2 }],
  'technical-analysis.pointAndFigure': () => [BARS(), { boxSize: 2, reversal: 3 }],
  'technical-analysis.rangeBars': () => [BARS(), { size: 4 }],
  'technical-analysis.tickBars': () => [BARS(), { count: 8 }],
  'technical-analysis.volumeBars': () => [BARS(), { volume: 5_000 }],
  'technical-analysis.dollarBars': () => [BARS(), { dollar: 500_000 }],
  'technical-analysis.imbalanceBars': () => [BARS(), { threshold: 4 }],
  'technical-analysis.volumeImbalanceBars': () => [BARS(), { threshold: 4_000 }],
  'technical-analysis.dollarImbalanceBars': () => [BARS(), { threshold: 400_000 }],
  'technical-analysis.runBars': () => [BARS(), { threshold: 6 }],
  'technical-analysis.volumeRunBars': () => [BARS(), { threshold: 6_000 }],
  'technical-analysis.dollarRunBars': () => [BARS(), { threshold: 600_000 }],
  'technical-analysis.zigzag': () => [BARS(), { deviation: 3 }],
  'technical-analysis.footprintBars': () => [trades(), { by: 'volume', threshold: 100 }],

  // price action
  'technical-analysis.sessionRanges': () => [BARS().slice(0, 24), sessionIds()],
  // acos/asin are domain-limited transforms ([-1, 1]); prices would NaN the whole series.
  'technical-analysis.acos': () => [CLOSES().map((_, i) => Math.sin(i / 5))],
  'technical-analysis.asin': () => [CLOSES().map((_, i) => Math.sin(i / 5))],
  'technical-analysis.previousSessionLevels': () => [BARS().slice(0, 24), sessionIds()],
  'technical-analysis.openingRange': () => [BARS(), { periods: 5 }],
  'technical-analysis.openingRangeBreakout': () => [BARS(), { periods: 5 }],
  'technical-analysis.orbRetest': () => [BARS(), { periods: 5 }],
  'technical-analysis.fibRetracement': () => [112, 96, [0, 0.382, 0.618, 1]],
  'technical-analysis.fibExtension': () => [
    { start: 96, end: 112, projectFrom: 104, levels: [0, 0.618, 1, 1.618] },
  ],
  'technical-analysis.lineAt': () => [{ slope: 0.5, intercept: 100, from: 0, to: 20 }, 10],

  // stats & divergences
  'technical-analysis.mavp': () => [
    {
      series: CLOSES(),
      periods: CLOSES().map((_, i) => 2 + (i % 9)),
      parameters: { minPeriod: 2, maxPeriod: 10, movingAverageType: 'sma' },
    },
  ],
  'technical-analysis.pairs': () => [CLOSES(), counterSeries()],
  'technical-analysis.divergences': () => [
    { price: CLOSES(), indicator: counterSeries(), parameters: { swing: { left: 3, right: 3 } } },
  ],

  // resampling & multi-timeframe alignment
  'technical-analysis.resample': () => [timeBars(36, 60_000), '5m', { includePartial: true }],
  'technical-analysis.alignToBars': () => {
    const higher = timeBars(6, 300_000);
    return [
      {
        higherSeries: higher.map((b) => b.close),
        higherBars: higher,
        lowerBars: timeBars(30, 60_000),
        options: { intervalMs: 300_000 },
      },
    ];
  },

  // signal DSL builders (operands are column refs / constants; builders never dereference them)
  'technical-analysis.condition': () => [['close'], (_ctx: unknown, i: number): boolean => i >= 0],
  'technical-analysis.crossOver': () => ['close', 'open'],
  'technical-analysis.crossUnder': () => ['close', 'open'],
  'technical-analysis.gt': () => ['close', 100],
  'technical-analysis.gte': () => ['close', 100],
  'technical-analysis.lt': () => ['close', 100],
  'technical-analysis.lte': () => ['close', 100],
  'technical-analysis.between': () => ['close', 95, 110],

  // candlestick engines
  'technical-analysis.cdlPattern': () => [BARS(), 'engulfing'],
  'technical-analysis.talibCandle': () => ['doji', BARS()],
  'technical-analysis.candleAverage': () => [
    BARS(),
    { range: 'realBody', averagePeriod: 10, factor: 1 },
  ],

  // async streaming adapters
  'technical-analysis.streamAsync': () => [sma.stream({ period: 3 }), asyncCloses()],
  'technical-analysis.collectAsync': () => [sma.stream({ period: 3 }), asyncCloses(), NaN],
};

// ── the candlestick catalog ──────────────────────────────────────────────────────────────────────
// Every catalog pattern is the same makeIndicator facade shape — (bars, parameters?) with an Empty
// parameters object — so they all share one fixture thunk. (`doji` and `inside` reach the sweep through
// their top-level cdlDoji / cdlInside aliases and are fixtured by identity fallback.)

const CANDLESTICK_KEYS = [
  'abandonedBaby',
  'advanceBlock',
  'beltHold',
  'breakaway',
  'closingMarubozu',
  'concealBabySwallow',
  'counterattack',
  'darkCloudCover',
  'dojiStar',
  'dragonflyDoji',
  'engulfing',
  'eveningDojiStar',
  'eveningStar',
  'gapSideSideWhite',
  'gravestoneDoji',
  'hammer',
  'hangingMan',
  'harami',
  'haramiCross',
  'highWave',
  'hikkake',
  'hikkakeMod',
  'homingPigeon',
  'identicalThreeCrows',
  'inNeck',
  'invertedHammer',
  'kicking',
  'kickingByLength',
  'ladderBottom',
  'longLeggedDoji',
  'longLine',
  'marubozu',
  'matchingLow',
  'matHold',
  'morningDojiStar',
  'morningStar',
  'onNeck',
  'piercing',
  'rickshawMan',
  'riseFallThreeMethods',
  'separatingLines',
  'shootingStar',
  'shortLine',
  'spinningTop',
  'stalledPattern',
  'stickSandwich',
  'takuri',
  'tasukiGap',
  'threeBlackCrows',
  'threeInside',
  'threeLineStrike',
  'threeOutside',
  'threeStarsInSouth',
  'threeWhiteSoldiers',
  'thrusting',
  'triStar',
  'twoCrows',
  'uniqueThreeRiver',
  'upsideGapTwoCrows',
  'xSideGapThreeMethods',
] as const;

const candleFixture: FixtureThunk = () => [BARS(), {}];
for (const name of CANDLESTICK_KEYS) {
  TA_FIXTURES[`technical-analysis.candlesticks.${name}`] = candleFixture;
}
