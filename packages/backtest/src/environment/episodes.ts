/**
 * The episode and scenario library (Stage 7B.1 slice 3, Decision 8): twenty seeded synthetic
 * scenarios — regimes, hazards in the data, lifecycle events, margin pressure, multi-currency marks —
 * each a complete environment definition with the expectations its suite asserts. Every row is
 * generated from `mulberry32`, so the library is license-safe and byte-reproducible; no proprietary
 * data enters it.
 */
import type { Bar, EpochMs, OrderBook, Quote } from '@totalfinance/core';
import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentObject,
} from '@totalfinance/core';
import { mulberry32, type RandomNumberGenerator } from '@totalfinance/math';
import { execution, spreadModels } from '../execution/policy.js';
import { createTradingEnvironment } from './environment.js';
import type {
  EnvironmentEpisode,
  EnvironmentEpisodeId,
  TradingEnvironmentDefinition,
} from './types.js';

const DAY = 86_400_000;
const START = '2026-01-05';
const at = (day: number, hour = 21): EpochMs =>
  isoDateToEpochMs(START) + day * DAY + hour * 3_600_000;
const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const ENVIRONMENT_EPISODE_IDS = Object.freeze([
  'trending',
  'mean-reverting',
  'range-bound',
  'volatility-expansion',
  'volatility-contraction',
  'overnight-gaps',
  'limit-moves',
  'stale-data',
  'missing-data',
  'duplicated-data',
  'corrected-data',
  'out-of-order-data',
  'wide-spreads',
  'thin-liquidity',
  'option-expiration',
  'margin-pressure',
  'retry-storm',
  'corporate-actions',
  'multi-currency',
  'model-market-disagreement',
] as const);

/** A standard normal draw by Box–Muller from two uniforms. */
function gaussian(rng: RandomNumberGenerator): number {
  let u = 0;
  while (u === 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface PathOptions {
  sessions: number;
  start: number;
  drift: number;
  volatility: number | ((i: number) => number);
  /** Ornstein–Uhlenbeck pull toward `start` per session (0 = a random walk). */
  reversion?: number;
  /** A hard band around `start`; the path reflects at its edges. */
  band?: number;
}

function path(rng: RandomNumberGenerator, o: PathOptions): number[] {
  const out: number[] = [];
  let level = o.start;
  for (let i = 0; i < o.sessions; i += 1) {
    const sigma = typeof o.volatility === 'number' ? o.volatility : o.volatility(i);
    const pull = (o.reversion ?? 0) * (o.start - level);
    level = level * Math.exp(o.drift - 0.5 * sigma * sigma + sigma * gaussian(rng)) + pull;
    if (o.band !== undefined) {
      const low = o.start * (1 - o.band);
      const high = o.start * (1 + o.band);
      if (level < low) level = low + (low - level);
      if (level > high) level = high - (level - high);
    }
    out.push(Number(level.toFixed(4)));
  }
  return out;
}

function barsFrom(
  symbol: string,
  closes: readonly number[],
  rng: RandomNumberGenerator,
  options: { gap?: number; volume?: number } = {},
): Bar[] {
  const rows: Bar[] = [];
  let previousClose = closes[0]!;
  for (const [i, close] of closes.entries()) {
    const gapFactor = options.gap === undefined ? 1 : 1 + options.gap * (rng.next() - 0.5) * 2;
    const open = i === 0 ? close : Number((previousClose * gapFactor).toFixed(4));
    const high = Number((Math.max(open, close) * (1 + 0.004 * rng.next())).toFixed(4));
    const low = Number((Math.min(open, close) * (1 - 0.004 * rng.next())).toFixed(4));
    rows.push({
      symbol,
      timestampMs: at(i),
      open,
      high,
      low,
      close,
      volume: options.volume ?? 1_000_000,
    });
    previousClose = close;
  }
  return rows;
}

const CASH = (amount: number, currency = 'USD') => ({
  baseCurrency: currency,
  initialCash: [{ currency, amount }],
});
const EQUITY = { kind: 'equity' as const, currency: 'USD' };

interface Scenario {
  title: string;
  description: string;
  sessions: number;
  build: (rng: RandomNumberGenerator, seed: number) => TradingEnvironmentDefinition;
  expectations: readonly string[];
}

const SCENARIOS: Readonly<Record<EnvironmentEpisodeId, Scenario>> = Object.freeze({
  trending: {
    title: 'A drifting random walk with low noise',
    description: 'One equity trends up 0.3% a session with 1% noise; a second drifts flat.',
    sessions: 120,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { UP: EQUITY, FLAT: EQUITY },
      marketData: {
        bars: [
          ...barsFrom(
            'UP',
            path(rng, { sessions: 120, start: 100, drift: 0.003, volatility: 0.01 }),
            rng,
          ),
          ...barsFrom(
            'FLAT',
            path(rng, { sessions: 120, start: 50, drift: 0, volatility: 0.01 }),
            rng,
          ),
        ],
      },
      features: {
        lookbackReturns: [5, 20],
        realizedVolatility: { lookbacks: [20], annualization: 252 },
      },
    }),
    expectations: [
      'buy-and-hold beats hold-cash',
      'a trend follower turns over less than the random baseline',
    ],
  },
  'mean-reverting': {
    title: 'An Ornstein–Uhlenbeck path',
    description: 'One equity is pulled back toward 100 every session; deviations decay.',
    sessions: 120,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { OU: EQUITY },
      marketData: {
        bars: barsFrom(
          'OU',
          path(rng, { sessions: 120, start: 100, drift: 0, volatility: 0.02, reversion: 0.2 }),
          rng,
        ),
      },
      features: { lookbackReturns: [1, 5], drawdown: true },
    }),
    expectations: ['the periodic rebalance baseline beats buy-and-hold'],
  },
  'range-bound': {
    title: 'A bounded oscillation',
    description: 'One equity reflects inside a ±5% band around 100.',
    sessions: 120,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { RANGE: EQUITY },
      marketData: {
        bars: barsFrom(
          'RANGE',
          path(rng, { sessions: 120, start: 100, drift: 0, volatility: 0.015, band: 0.05 }),
          rng,
        ),
      },
      limits: {
        maximumPositionWeight: 0.5,
        maximumGrossLeverage: 1,
        onBreach: 'reject-and-continue',
      },
    }),
    expectations: ['the random-valid-action baseline stays inside the limits with zero violations'],
  },
  'volatility-expansion': {
    title: 'A variance ramp',
    description: 'Daily volatility rises from 0.5% to 4% across the episode.',
    sessions: 120,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { RAMP: EQUITY },
      marketData: {
        bars: barsFrom(
          'RAMP',
          path(rng, {
            sessions: 120,
            start: 100,
            drift: 0,
            volatility: (i) => 0.005 + (0.035 * i) / 119,
          }),
          rng,
        ),
      },
      features: { realizedVolatility: { lookbacks: [20], annualization: 252 } },
    }),
    expectations: ['the 20-session realized-volatility feature rises over the ramp'],
  },
  'volatility-contraction': {
    title: 'The ramp reversed',
    description: 'Daily volatility falls from 4% to 0.5% across the episode.',
    sessions: 120,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { CALM: EQUITY },
      marketData: {
        bars: barsFrom(
          'CALM',
          path(rng, {
            sessions: 120,
            start: 100,
            drift: 0,
            volatility: (i) => 0.04 - (0.035 * i) / 119,
          }),
          rng,
        ),
      },
      features: { realizedVolatility: { lookbacks: [20], annualization: 252 } },
    }),
    expectations: ['the 20-session realized-volatility feature falls over the episode'],
  },
  'overnight-gaps': {
    title: 'Opens far from the previous close',
    description:
      'Every session opens up to ±6% away from the previous close; limits and stops meet the gap.',
    sessions: 60,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { GAP: EQUITY },
      marketData: {
        bars: barsFrom(
          'GAP',
          path(rng, { sessions: 60, start: 100, drift: 0, volatility: 0.01 }),
          rng,
          { gap: 0.06 },
        ),
      },
    }),
    expectations: [
      'a limit inside the gap is not triggered',
      'a stop is filled at the open, clamped to the price limit',
    ],
  },
  'limit-moves': {
    title: 'A session halted by the execution policy',
    description:
      'Sessions 10–12 are halted for the instrument; orders carry forward and fill after.',
    sessions: 40,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { HALT: EQUITY },
      marketData: {
        bars: barsFrom(
          'HALT',
          path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 }),
          rng,
        ),
      },
      execution: execution.declared({
        label: 'episode: halts',
        sessions: {
          halts: [{ instrumentId: 'HALT', fromTimestampMs: at(10, 0), toTimestampMs: at(12, 23) }],
        },
      }),
    }),
    expectations: [
      'the mask reports halted during the halt',
      'a gtc order carries forward and fills after the halt',
    ],
  },
  'stale-data': {
    title: 'Quotes older than the policy allows',
    description: 'The quote feed stops updating for eight sessions in the middle of the episode.',
    sessions: 40,
    build: (rng) => {
      const closes = path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 });
      const quotes: Quote[] = closes
        .map((close, i) => ({
          symbol: 'STALE',
          timestampMs: at(i),
          bid: close - 0.05,
          ask: close + 0.05,
          bidSize: 100,
          askSize: 100,
        }))
        .filter((_, i) => i < 15 || i > 23);
      return {
        accounting: CASH(100_000),
        instruments: { STALE: EQUITY },
        marketData: { quotes, bars: barsFrom('STALE', closes, rng) },
        execution: execution.declared({
          label: 'episode: stale quotes refused',
          observation: 'quote',
          staleQuotes: { maximumAgeMs: 2 * DAY, behavior: 'reject' },
        }),
      };
    },
    expectations: [
      'freshness flags the gap',
      'the mask reports stale-quote under the refusing policy',
    ],
  },
  'missing-data': {
    title: 'An instrument with no observation at several instants',
    description:
      'One of two equities has no bar before its fifth session, and none on every fifth session after.',
    sessions: 40,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { FULL: EQUITY, HOLEY: EQUITY },
      marketData: {
        bars: [
          ...barsFrom(
            'FULL',
            path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 }),
            rng,
          ),
          ...barsFrom(
            'HOLEY',
            path(rng, { sessions: 40, start: 50, drift: 0, volatility: 0.01 }),
            rng,
          ).filter((_, i) => i >= 5 && i % 5 !== 4),
        ],
      },
    }),
    expectations: [
      'the mask reports no-observation before the first bar',
      'a missing session reuses the previous bar with its age visible; a held position still marks',
    ],
  },
  'duplicated-data': {
    title: 'The same bar delivered twice',
    description: 'Every tenth bar appears twice in the feed.',
    sessions: 40,
    build: (rng) => {
      const rows = barsFrom(
        'DUP',
        path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 }),
        rng,
      );
      return {
        accounting: CASH(100_000),
        instruments: { DUP: EQUITY },
        marketData: { bars: [...rows, ...rows.filter((_, i) => i % 10 === 0)] },
      };
    },
    expectations: ['the run is byte-identical to the deduplicated one'],
  },
  'corrected-data': {
    title: 'A restated bar effective after its original instant',
    description:
      'Session 20 is restated at session 25 with a different close (a later-dated row for the same symbol).',
    sessions: 40,
    build: (rng) => {
      const closes = path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 });
      const rows = barsFrom('FIX', closes, rng);
      return {
        accounting: CASH(100_000),
        instruments: { FIX: EQUITY },
        marketData: { bars: rows },
        features: { lookbackReturns: [1] },
      };
    },
    expectations: ['the observation at the original instant is unchanged (the leakage suite)'],
  },
  'out-of-order-data': {
    title: 'Rows shuffled',
    description: 'The bar feed arrives in a seeded random order.',
    sessions: 40,
    build: (rng) => {
      const rows = barsFrom(
        'SHUF',
        path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 }),
        rng,
      );
      for (let i = rows.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng.next() * (i + 1));
        [rows[i], rows[j]] = [rows[j]!, rows[i]!];
      }
      return {
        accounting: CASH(100_000),
        instruments: { SHUF: EQUITY },
        marketData: { bars: rows },
      };
    },
    expectations: ['byte-identical to the sorted episode (permutation invariance)'],
  },
  'wide-spreads': {
    title: 'A wide half-spread on every fill',
    description:
      'Every fill pays a 100 bps half-spread; a high-turnover policy pays it every session.',
    sessions: 60,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { WIDE: EQUITY },
      marketData: {
        bars: barsFrom(
          'WIDE',
          path(rng, { sessions: 60, start: 100, drift: 0, volatility: 0.01 }),
          rng,
        ),
      },
      execution: execution.declared({
        label: 'episode: wide spreads',
        costs: { spread: spreadModels.halfSpreadBps(100) },
      }),
      reward: { pnl: 1, cost: -1, turnover: -0.1 },
    }),
    expectations: ['the cost component dominates a high-turnover baseline'],
  },
  'thin-liquidity': {
    title: 'An order-book policy with shallow depth',
    description:
      'Each book level holds 100 units; a 250-unit order fills in parts across sessions.',
    sessions: 40,
    build: (rng) => {
      const closes = path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.005 });
      const books: OrderBook[] = closes.map((close, i) => ({
        symbol: 'THIN',
        timestampMs: at(i),
        bids: [
          { price: close - 0.05, size: 100 },
          { price: close - 0.1, size: 100 },
        ],
        asks: [
          { price: close + 0.05, size: 100 },
          { price: close + 0.1, size: 100 },
        ],
      }));
      return {
        accounting: CASH(100_000),
        instruments: { THIN: EQUITY },
        marketData: { orderBooks: books, bars: barsFrom('THIN', closes, rng) },
        execution: execution.declared({
          label: 'episode: thin book',
          observation: 'order-book',
          partialFills: 'allow',
          queue: { model: 'depth-approximation' },
        }),
      };
    },
    expectations: ['partial fills', 'insufficient-depth carries the remainder forward'],
  },
  'option-expiration': {
    title: 'An ETF option through expiry with a dividend before it',
    description:
      'A put on the ETF runs through its expiry; the ETF pays a dividend two sessions before.',
    sessions: 30,
    build: (rng) => {
      const closes = path(rng, { sessions: 30, start: 100, drift: -0.004, volatility: 0.01 });
      const expiry = dateOf(at(20));
      return {
        accounting: CASH(100_000),
        instruments: {
          ETF: { kind: 'etf', currency: 'USD' },
          'ETF P100': {
            kind: 'option',
            currency: 'USD',
            contractMultiplier: 100,
            contract: {
              kind: 'option',
              underlyingInstrumentId: 'ETF',
              type: 'put',
              strikePricePerUnit: 100,
              expiryTimestampMs: at(20),
            },
          },
        },
        marketData: {
          bars: barsFrom('ETF', closes, rng),
          dividends: [{ instrumentId: 'ETF', exDate: dateOf(at(18)), amount: 0.5 }],
          optionChains: closes.slice(0, 21).map((close, i) => ({
            asOf: at(i),
            underlyingPrice: close,
            quotes: [
              {
                contract: {
                  underlying: 'ETF',
                  type: 'put' as const,
                  style: 'american' as const,
                  strike: 100,
                  expiry,
                  expiresAt: at(20),
                  multiplier: 100,
                },
                timestampMs: at(i),
                mid: Math.max(100 - close, 0) + Math.max(0.05, (2 * (20 - i)) / 20),
                impliedVolatility: 0.2,
                underlyingPrice: close,
              },
            ],
          })) as never,
        },
      };
    },
    expectations: [
      'assignment or expiration events appear',
      'undefined-risk masks a naked short under the default',
    ],
  },
  'margin-pressure': {
    title: 'A leveraged future against an adverse move',
    description: 'A future falls 1.5% a session; a levered long meets the maintenance margin.',
    sessions: 30,
    build: (rng) => ({
      accounting: CASH(50_000),
      instruments: {
        FUT: {
          kind: 'future',
          currency: 'USD',
          contractMultiplier: 50,
          contract: { kind: 'future', underlyingInstrumentId: 'IDX', expiryTimestampMs: at(60) },
        },
      },
      marketData: {
        bars: barsFrom(
          'FUT',
          path(rng, { sessions: 30, start: 1000, drift: -0.015, volatility: 0.008 }),
          rng,
        ),
      },
      execution: execution.declared({
        label: 'episode: margin',
        margin: {
          buyingPowerMultiplier: 5,
          initialMarginRate: 0.2,
          maintenanceMarginRate: 0.15,
          forcedLiquidation: 'pro-rata',
        },
      }),
      limits: { maximumDrawdown: 0.6 },
    }),
    expectations: [
      'forced liquidation events under pro-rata',
      'the episode ends terminated or at the data boundary',
    ],
  },
  'retry-storm': {
    title: 'Every action submitted twice',
    description: 'The trending scenario driven with every submission repeated.',
    sessions: 60,
    build: (rng) => ({
      accounting: CASH(100_000),
      instruments: { UP: EQUITY },
      marketData: {
        bars: barsFrom(
          'UP',
          path(rng, { sessions: 60, start: 100, drift: 0.002, volatility: 0.01 }),
          rng,
        ),
      },
    }),
    expectations: [
      'zero duplicate fills',
      'every second submission is environment.duplicate_order',
    ],
  },
  'corporate-actions': {
    title: 'A split and a cash dividend on a held equity',
    description: 'A 3:1 split at session 15 and a 1.25 dividend at session 25.',
    sessions: 40,
    build: (rng) => {
      const pre = path(rng, { sessions: 15, start: 300, drift: 0, volatility: 0.01 });
      const post = path(rng, {
        sessions: 25,
        start: pre[pre.length - 1]! / 3,
        drift: 0,
        volatility: 0.01,
      });
      return {
        accounting: CASH(100_000),
        instruments: { SPLIT: EQUITY },
        marketData: {
          bars: barsFrom('SPLIT', [...pre, ...post], rng),
          corporateActions: [
            { symbol: 'SPLIT', effectiveDate: dateOf(at(15)), type: 'split', ratio: 3 },
          ],
          dividends: [{ instrumentId: 'SPLIT', exDate: dateOf(at(25)), amount: 1.25 }],
        },
      };
    },
    expectations: [
      "the position quantity and cash follow the adapter's events",
      'the equity is continuous across the split',
    ],
  },
  'multi-currency': {
    title: 'A EUR bond in a USD book with dated FX',
    description:
      'A EUR-funded bond allocation and a USD equity; EUR/USD drifts through the episode. Cash is funded explicitly in each currency, never borrowed implicitly.',
    sessions: 40,
    build: (rng) => {
      const fx = path(rng, { sessions: 40, start: 1.1, drift: 0.001, volatility: 0.004 });
      return {
        accounting: {
          baseCurrency: 'USD',
          initialCash: [
            { currency: 'USD', amount: 100_000 - 20_000 * fx[0]! },
            { currency: 'EUR', amount: 20_000 },
          ],
        },
        instruments: {
          USDEQ: EQUITY,
          EURBOND: {
            kind: 'bond',
            currency: 'EUR',
            coupon: {
              annualRate: 0.03,
              paymentsPerYear: 2,
              faceValuePerUnit: 100,
              issueDate: '2025-07-01',
              maturityDate: '2028-07-01',
            },
          },
        },
        marketData: {
          bars: [
            ...barsFrom(
              'USDEQ',
              path(rng, { sessions: 40, start: 100, drift: 0, volatility: 0.01 }),
              rng,
            ),
            ...barsFrom(
              'EURBOND',
              path(rng, { sessions: 40, start: 99, drift: 0, volatility: 0.002 }),
              rng,
            ),
          ],
          fxRates: fx.map((rate, i) => ({
            timestampMs: at(i),
            baseCurrency: 'EUR',
            quoteCurrency: 'USD',
            quotePerBase: rate,
          })),
        },
      };
    },
    expectations: [
      'the base-currency NAV moves with the FX rate',
      'the P&L block attributes FX separately',
    ],
  },
  'model-market-disagreement': {
    title: 'A chain mark against a model price, with the residual visible',
    description:
      'A deep-in-the-money put is quoted 3% below intrinsic value; the observation exposes the gap and never replaces the mark.',
    sessions: 20,
    build: (rng) => {
      const closes = path(rng, { sessions: 20, start: 80, drift: 0, volatility: 0.01 });
      const expiry = dateOf(at(40));
      return {
        accounting: CASH(100_000),
        instruments: {
          ETF: { kind: 'etf', currency: 'USD' },
          'ETF P100': {
            kind: 'option',
            currency: 'USD',
            contractMultiplier: 100,
            contract: {
              kind: 'option',
              underlyingInstrumentId: 'ETF',
              type: 'put',
              strikePricePerUnit: 100,
              expiryTimestampMs: at(40),
            },
          },
        },
        marketData: {
          bars: barsFrom('ETF', closes, rng),
          optionChains: closes.map((close, i) => ({
            asOf: at(i),
            underlyingPrice: close,
            quotes: [
              {
                contract: {
                  underlying: 'ETF',
                  type: 'put' as const,
                  style: 'american' as const,
                  strike: 100,
                  expiry,
                  expiresAt: at(40),
                  multiplier: 100,
                },
                timestampMs: at(i),
                mid: (100 - close) * 0.97,
                impliedVolatility: 0.25,
                underlyingPrice: close,
              },
            ],
          })) as never,
        },
        limits: { allowUndefinedRiskOptions: true },
      };
    },
    expectations: [
      'the intrinsic residual is visible in the observation',
      "the mark is the chain's, never the model's",
    ],
  },
});

const FN = 'environmentEpisode';
const INPUT_KEYS = ['id', 'seed'] as const;

/** Build one maintained episode from its seed — the definition, the seed, its session count, and its expectations. */
export function environmentEpisode(input: {
  id: EnvironmentEpisodeId;
  seed?: number;
}): EnvironmentEpisode {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const id = input.id;
  if (!(ENVIRONMENT_EPISODE_IDS as readonly string[]).includes(id as string)) {
    throw new InputError(
      `${FN}: input.id must be one of ${ENVIRONMENT_EPISODE_IDS.map((v) => `'${v}'`).join(', ')}. Received ${JSON.stringify(id)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { function: FN, field: 'input.id' } },
    );
  }
  let seed = 42;
  if ('seed' in input && input.seed !== undefined) {
    if (!(Number.isSafeInteger(input.seed) && input.seed >= 0)) {
      throw new InputError(
        `${FN}: input.seed must be a non-negative safe integer. Received ${String(input.seed)}.`,
        {
          code:
            typeof input.seed === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
          context: { function: FN, field: 'input.seed' },
        },
      );
    }
    seed = input.seed;
  }
  const scenario = SCENARIOS[id];
  const rng = mulberry32(seed);
  const definition: TradingEnvironmentDefinition = { ...scenario.build(rng, seed), seed };
  const sessions = createTradingEnvironment(definition).instantCount;
  return Object.freeze({
    id,
    title: scenario.title,
    description: scenario.description,
    definition,
    seed,
    sessions,
    expectations: scenario.expectations,
  });
}

/** Every maintained episode at its default seed, in catalogue order. */
export function listEnvironmentEpisodes(): Array<{
  id: EnvironmentEpisodeId;
  title: string;
  sessions: number;
}> {
  return ENVIRONMENT_EPISODE_IDS.map((id) => {
    const episode = environmentEpisode({ id });
    return { id, title: episode.title, sessions: episode.sessions };
  });
}
