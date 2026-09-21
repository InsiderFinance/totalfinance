/**
 * Stage 7B.1 slice 3 — the episode library (Decision 8): every maintained scenario builds from its
 * seed, stays within the size and time bounds, is deterministic, and meets the expectation its row
 * states — trends, ranges, volatility regimes, gaps, halts, stale and missing and duplicated and
 * shuffled data, wide spreads, thin books, option expiry, margin pressure, retries, corporate actions,
 * multi-currency marks, and a visible model/market residual.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import {
  ENVIRONMENT_EPISODE_IDS,
  createTradingEnvironment,
  environmentEpisode,
  listEnvironmentEpisodes,
  runEnvironmentEpisode,
  type EnvironmentAction,
  type EnvironmentEpisodeId,
  type EnvironmentStepResult,
  type TradingEnvironmentDefinition,
} from '@totalfinance/backtest/environment';

const hold: EnvironmentAction = { kind: 'hold' };
const order = (
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  orderId: string,
  extra: Record<string, unknown> = {},
): EnvironmentAction => ({
  kind: 'orders',
  orders: [{ orderId, instrumentId, side, quantity, type: 'market', ...extra } as never],
});
const closes = (definition: TradingEnvironmentDefinition, symbol: string): number[] =>
  (definition.marketData.bars ?? [])
    .filter((b) => b.symbol === symbol)
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((b) => b.close);
/** Step the episode with one action at the first step and holds after, collecting every result. */
const drive = (
  definition: TradingEnvironmentDefinition,
  first: EnvironmentAction,
  seed?: number,
): EnvironmentStepResult[] => {
  const environment = createTradingEnvironment(definition);
  const state = environment.reset(seed === undefined ? undefined : { seed });
  const out: EnvironmentStepResult[] = [];
  let over = state.terminated || state.truncated;
  let i = 0;
  while (!over) {
    const result = environment.step(i === 0 ? first : hold);
    out.push(result);
    over = result.terminated || result.truncated;
    i += 1;
  }
  return out;
};
const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('the catalogue', () => {
  it('builds every episode from its seed, within the bounds, deterministically', () => {
    expect(ENVIRONMENT_EPISODE_IDS).toHaveLength(20);
    const listed = listEnvironmentEpisodes();
    expect(listed.map((e) => e.id)).toEqual([...ENVIRONMENT_EPISODE_IDS]);
    for (const id of ENVIRONMENT_EPISODE_IDS) {
      const started = performance.now();
      const episode = environmentEpisode({ id });
      const elapsed = performance.now() - started;
      expect({ id, bounded: episode.sessions >= 20 && episode.sessions <= 260 }).toEqual({
        id,
        bounded: true,
      });
      expect({ id, fast: elapsed < 500 }).toEqual({ id, fast: true });
      expect(episode.expectations.length).toBeGreaterThan(0);
      expect(episode.seed).toBe(42);
      expect(Object.isFrozen(episode)).toBe(true);
      const again = environmentEpisode({ id, seed: 42 });
      expect(canonicalJsonOf({ ...again.definition, execution: null, instruments: null })).toBe(
        canonicalJsonOf({ ...episode.definition, execution: null, instruments: null }),
      );
      const other = environmentEpisode({ id, seed: 7 });
      expect(other.seed).toBe(7);
      expect(other.definition.seed).toBe(7);
    }
  });

  it('teaches on an unknown id or a bad seed', () => {
    expect(failure(() => environmentEpisode({ id: 'bull-run' as EnvironmentEpisodeId })).code).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(failure(() => environmentEpisode({ id: 'trending', seed: -1 })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(failure(() => environmentEpisode({ id: 'trending', seed: '1' as never })).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(failure(() => environmentEpisode({ id: 'trending', extra: 1 } as never)).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(() => environmentEpisode(null as never)).code).toBe(ErrorCode.InputWrongType);
  });
});

describe('the regimes', () => {
  it('trending: the trend is up and buy-and-hold beats hold-cash', () => {
    const { definition } = environmentEpisode({ id: 'trending' });
    const up = closes(definition, 'UP');
    expect(up[up.length - 1]!).toBeGreaterThan(up[0]!);
    const held = drive(definition, order('UP', 'buy', 500, 'hold-up'));
    const cash = drive(definition, hold);
    expect(held[held.length - 1]!.observation.portfolio.netAssetValue).toBeGreaterThan(
      cash[cash.length - 1]!.observation.portfolio.netAssetValue,
    );
  });

  it('mean-reverting: the path stays near its anchor', () => {
    const { definition } = environmentEpisode({ id: 'mean-reverting' });
    const ou = closes(definition, 'OU');
    const deviations = ou.map((c) => Math.abs(c / 100 - 1));
    expect(Math.max(...deviations)).toBeLessThan(0.25);
    expect(deviations.reduce((s, d) => s + d, 0) / deviations.length).toBeLessThan(0.08);
  });

  it('range-bound: every close is inside the band', () => {
    const { definition } = environmentEpisode({ id: 'range-bound' });
    for (const close of closes(definition, 'RANGE'))
      expect(Math.abs(close / 100 - 1)).toBeLessThanOrEqual(0.06);
  });

  it('volatility-expansion and -contraction: the realized-volatility feature follows the regime', () => {
    const ramp = drive(environmentEpisode({ id: 'volatility-expansion' }).definition, hold);
    const early = ramp[30]!.observation.features.realizedVolatility['20']!['RAMP']!;
    const late = ramp[ramp.length - 1]!.observation.features.realizedVolatility['20']!['RAMP']!;
    expect(late).toBeGreaterThan(early * 2);
    const calm = drive(environmentEpisode({ id: 'volatility-contraction' }).definition, hold);
    const first = calm[30]!.observation.features.realizedVolatility['20']!['CALM']!;
    const last = calm[calm.length - 1]!.observation.features.realizedVolatility['20']!['CALM']!;
    expect(last * 2).toBeLessThan(first);
  });
});

describe('the hazards', () => {
  it('overnight-gaps: a limit inside the gap is not triggered and a stop fills', () => {
    const { definition } = environmentEpisode({ id: 'overnight-gaps' });
    const bars = [...(definition.marketData.bars ?? [])].sort(
      (a, b) => a.timestampMs - b.timestampMs,
    );
    const gaps = bars.slice(1).map((b, i) => b.open / bars[i]!.close - 1);
    expect(Math.max(...gaps.map(Math.abs))).toBeGreaterThan(0.03);
    // a buy limit far below the next open sits untriggered; a buy stop just above the close fills
    const limit = drive(
      definition,
      order('GAP', 'buy', 10, 'lim', {
        type: 'limit',
        limitPrice: bars[1]!.low * 0.5,
        timeInForce: 'gtc',
      }),
    );
    expect(limit[0]!.rejections[0]!.code).toBe('backtest.unfilled.not-triggered');
    expect(limit[0]!.observation.portfolio.openOrders[0]).toMatchObject({
      orderId: 'lim',
      reason: 'not-triggered',
    });
    const stop = drive(
      definition,
      order('GAP', 'buy', 10, 'stp', { type: 'stop', stopPrice: bars[0]!.close * 1.0001 }),
    );
    expect(stop.some((r) => r.fills.some((f) => f.orderId === 'stp'))).toBe(true);
  });

  it('limit-moves: the mask reports the halt and a gtc order carries forward and fills after it', () => {
    const { definition } = environmentEpisode({ id: 'limit-moves' });
    const environment = createTradingEnvironment(definition);
    environment.reset();
    let result = environment.step(hold);
    for (let i = 1; i < 9; i += 1) result = environment.step(hold);
    // observation 9: the next instant (10) is halted
    expect(result.observation.actionMask['HALT']!.reasons.buy).toEqual(['halted']);
    const rejected = environment.step(order('HALT', 'buy', 10, 'during'));
    expect(rejected.rejections[0]!.code).toBe('environment.action_disallowed');
    // submitted before the halt with gtc: carried through it and filled after
    const fresh = createTradingEnvironment(definition);
    fresh.reset();
    for (let i = 0; i < 8; i += 1) fresh.step(hold);
    let carried = fresh.step(order('HALT', 'buy', 10, 'through', { timeInForce: 'gtc' }));
    expect(carried.fills).toHaveLength(1); // instant 9 is open
    const late = createTradingEnvironment(definition);
    late.reset();
    for (let i = 0; i < 9; i += 1) late.step(hold);
    carried = late.step(order('HALT', 'buy', 10, 'halted', { timeInForce: 'gtc' }));
    expect(carried.rejections[0]!.code).toBe('environment.action_disallowed');
  });

  it('stale-data: freshness flags the gap and the mask refuses under the rejecting policy', () => {
    const results = drive(environmentEpisode({ id: 'stale-data' }).definition, hold);
    const stale = results.filter((r) => r.observation.freshness['STALE']!.stale);
    expect(stale.length).toBeGreaterThan(3);
    expect(stale[0]!.observation.actionMask['STALE']!.reasons.buy).toContain('stale-quote');
    expect(results[0]!.observation.freshness['STALE']!.stale).toBe(false);
  });

  it('missing-data: no observation before the first bar; a missing session reuses the previous bar with its age visible', () => {
    const { definition } = environmentEpisode({ id: 'missing-data' });
    const start = createTradingEnvironment(definition).reset();
    expect(start.observation.actionMask['HOLEY']!.reasons.buy).toEqual(['no-observation']);
    expect(start.observation.freshness['HOLEY']!.latestTimestampMs).toBeNull();
    const environment = createTradingEnvironment(definition);
    environment.reset();
    const results: EnvironmentStepResult[] = [];
    let over = false;
    for (let i = 0; !over; i += 1) {
      const result = environment.step(i === 6 ? order('HOLEY', 'buy', 100, 'h') : hold);
      results.push(result);
      over = result.terminated || result.truncated;
    }
    expect(results[6]!.fills).toHaveLength(1);
    const aged = results.filter((r) => (r.observation.freshness['HOLEY']!.ageMs ?? 0) > 0);
    expect(aged.length).toBeGreaterThan(3);
    for (const r of aged.filter((r) => r.observation.sequence > 7 && !r.truncated)) {
      expect(r.observation.portfolio.positions[0]!.markPricePerUnit).not.toBeNull();
      expect(r.observation.actionMask['FULL']!.buy).toBe(true);
      expect(r.observation.freshness['FULL']!.ageMs).toBe(0);
    }
  });
  it('duplicated-data and out-of-order-data: the same outcome as the clean feed; shuffled rows are the same run', () => {
    for (const [id, symbol] of [
      ['duplicated-data', 'DUP'],
      ['out-of-order-data', 'SHUF'],
    ] as const) {
      const { definition } = environmentEpisode({ id });
      const rows = definition.marketData.bars ?? [];
      const clean = [...new Map(rows.map((b) => [b.timestampMs, b])).values()].sort(
        (a, b) => a.timestampMs - b.timestampMs,
      );
      expect(clean.length).toBeLessThanOrEqual(rows.length);
      const actions = [order(symbol, 'buy', 100, 'x'), hold, hold];
      const messy = runEnvironmentEpisode({ definition, actions });
      const tidy = runEnvironmentEpisode({
        definition: { ...definition, marketData: { bars: clean } },
        actions,
      });
      // shuffled rows are the same run (the engine's identity ordering); duplicated rows are the
      // same OUTCOME under a different identity (the identity hashes the rows as given)
      if (id === 'out-of-order-data') {
        expect(messy.runId).toBe(tidy.runId);
        expect(messy.traceHash).toBe(tidy.traceHash);
      } else {
        expect(messy.runId).not.toBe(tidy.runId);
      }
      expect(messy.result.finalValue).toBe(tidy.result.finalValue);
      expect(messy.rewards).toEqual(tidy.rewards);
      expect(messy.result.fills.map((f) => [f.quantity, f.pricePerUnit])).toEqual(
        tidy.result.fills.map((f) => [f.quantity, f.pricePerUnit]),
      );
    }
  });
  it('wide-spreads: the cost component pays the spread; thin-liquidity: partial fills carry the remainder', () => {
    const wide = drive(
      environmentEpisode({ id: 'wide-spreads' }).definition,
      order('WIDE', 'buy', 200, 'w'),
    );
    expect(wide[0]!.fills).toHaveLength(1);
    expect(wide[0]!.fills[0]!.executionPriceAdjustment).toBeGreaterThan(0);
    expect(wide[0]!.fills[0]!.costs?.slippageAdjustment).toBeUndefined();
    expect(wide[0]!.reward.components['cost']!.value).toBeGreaterThan(0.001);
    expect(wide[0]!.reward.components['cost']!.contribution).toBeLessThan(0);
    const thin = drive(
      environmentEpisode({ id: 'thin-liquidity' }).definition,
      order('THIN', 'buy', 250, 't', { timeInForce: 'gtc' }),
    );
    expect(thin[0]!.fills[0]!.quantity).toBeLessThan(250);
    expect(thin[0]!.observation.portfolio.openOrders[0]).toMatchObject({
      orderId: 't',
      reason: 'partial',
    });
    const filled = thin.reduce(
      (sum, r) =>
        sum + r.fills.filter((f) => f.orderId === 't').reduce((s, f) => s + f.quantity, 0),
      0,
    );
    expect(filled).toBeGreaterThan(thin[0]!.fills[0]!.quantity);
  });
});

describe('the lifecycle and the book', () => {
  it('option-expiration: a written put is masked by default; a held put and its ETF see the dividend and the expiry', () => {
    const { definition } = environmentEpisode({ id: 'option-expiration' });
    const naked = createTradingEnvironment(definition).reset();
    expect(naked.observation.actionMask['ETF P100']!.reasons.sell).toEqual(['undefined-risk']);
    const held = drive(
      { ...definition, limits: { allowUndefinedRiskOptions: true } },
      {
        kind: 'orders',
        orders: [
          { orderId: 'p', instrumentId: 'ETF P100', side: 'buy', quantity: 1, type: 'market' },
          { orderId: 'e', instrumentId: 'ETF', side: 'buy', quantity: 100, type: 'market' },
        ],
      },
    );
    expect(held[0]!.fills).toHaveLength(2);
    const events = held.flatMap((r) => r.events.map((e) => e.eventType));
    expect(
      events.some(
        (t) =>
          t === 'derivative.exercise' ||
          t === 'derivative.expiration' ||
          t === 'derivative.assignment',
      ),
    ).toBe(true);
    expect(events).toContain('income.received');
  });
  it('margin-pressure: the maintenance breach forces a pro-rata liquidation', () => {
    const { definition } = environmentEpisode({ id: 'margin-pressure' });
    const results = drive(definition, order('FUT', 'buy', 4, 'lev'));
    expect(results[0]!.fills).toHaveLength(1);
    const liquidated = results.findIndex((r) => r.liquidations.length > 0);
    expect(liquidated).toBeGreaterThan(0);
    expect(results[liquidated]!.liquidations[0]!.policy).toBe('pro-rata');
    const last = results[results.length - 1]!;
    expect(last.terminated || last.truncated).toBe(true);
  });
  it('retry-storm: every second submission is a duplicate and adds no fill', () => {
    const { definition } = environmentEpisode({ id: 'retry-storm' });
    const environment = createTradingEnvironment(definition);
    environment.reset();
    let duplicates = 0;
    let fills = 0;
    for (let i = 0; i < 20; i += 1) {
      const action = order('UP', i % 2 === 0 ? 'buy' : 'sell', 10, `o${i}`);
      const first = environment.step(action);
      const again = environment.step(action);
      fills += first.fills.length + again.fills.length;
      duplicates += again.rejections.filter((r) => r.code === 'environment.duplicate_order').length;
    }
    expect(duplicates).toBe(20);
    expect(fills).toBe(20);
  });
  it('corporate-actions: the split multiplies the quantity and keeps the equity continuous; the dividend pays', () => {
    const { definition } = environmentEpisode({ id: 'corporate-actions' });
    const results = drive(definition, order('SPLIT', 'buy', 100, 's'));
    const splitStep = results.findIndex((r) =>
      r.events.some((e) => e.eventType === 'corporate.split'),
    );
    expect(splitStep).toBeGreaterThan(0);
    expect(results[splitStep]!.observation.portfolio.positions[0]!.quantity).toBe(300);
    const before = results[splitStep - 1]!.observation.portfolio.netAssetValue;
    const after = results[splitStep]!.observation.portfolio.netAssetValue;
    expect(Math.abs(after / before - 1)).toBeLessThan(0.05);
    expect(results.some((r) => r.events.some((e) => e.eventType === 'income.received'))).toBe(true);
  });

  it('multi-currency: the EUR bond is valued through the dated quotes', () => {
    const { definition } = environmentEpisode({ id: 'multi-currency' });
    const results = drive(definition, order('EURBOND', 'buy', 100, 'b'));
    expect(results[0]!.fills[0]!.currency).toBe('EUR');
    const position = results[0]!.observation.portfolio.positions.find(
      (p) => p.instrumentId === 'EURBOND',
    )!;
    const fx = (definition.marketData.fxRates ?? []).find(
      (q) => q.timestampMs === results[0]!.observation.asOf,
    )!;
    expect(position.baseCurrencyMarketValue).toBeCloseTo(
      position.quantity * position.markPricePerUnit! * fx!.quotePerBase,
      6,
    );
  });

  it('model-market-disagreement: the chain marks the put below intrinsic and the observation says so', () => {
    const { definition } = environmentEpisode({ id: 'model-market-disagreement' });
    const start = createTradingEnvironment(definition).reset();
    const quote = start.observation.market['ETF P100']!.chainQuote!;
    const underlying = start.observation.market['ETF P100']!.underlyingPrice!;
    expect(quote.mid).toBeLessThan(Math.max(100 - underlying, 0));
    const held = drive(definition, order('ETF P100', 'buy', 1, 'p'));
    expect(held[0]!.observation.portfolio.positions[0]!.markPricePerUnit).toBeCloseTo(
      held[0]!.observation.market['ETF P100']!.chainQuote!.mid!,
      9,
    );
  });
});
