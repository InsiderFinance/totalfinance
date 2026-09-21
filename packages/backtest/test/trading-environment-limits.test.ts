/**
 * Stage 7B.1 slice 2 — limits through FC7's monitor (pre-trade projection, post-trade judgment,
 * terminate versus reject-and-continue), the action mask as a promise, the reward composition
 * (components always separate, invariance of the accounting), features and freshness from the
 * prefix only (the leakage suite), the retry suite, and the guards.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, type Bar } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { execution } from '@totalfinance/backtest/execution';
import {
  createTradingEnvironment,
  requireEnvironmentLimits,
  requireFeatureRecipes,
  requireRewardComposition,
  type EnvironmentAction,
  type EnvironmentObservation,
  type TradingEnvironmentDefinition,
} from '@totalfinance/backtest/environment';
import { at, bars, dateOf, drift, flatPath, portfolioJourneys } from './portfolio-journeys.js';

const two = (
  overrides: Partial<TradingEnvironmentDefinition> = {},
): TradingEnvironmentDefinition => ({
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: {
    AAA: { kind: 'equity', currency: 'USD' },
    BBB: { kind: 'equity', currency: 'USD' },
  },
  marketData: { bars: [...bars('AAA', drift(12, 100, 1)), ...bars('BBB', drift(12, 50, -1))] },
  ...overrides,
});
const order = (
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  orderId?: string,
): EnvironmentAction => ({
  kind: 'orders',
  orders: [
    { ...(orderId !== undefined ? { orderId } : {}), instrumentId, side, quantity, type: 'market' },
  ],
});
const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('limits', () => {
  it('projects each queued order at the current marks and rejects a breach with the limit named', () => {
    const environment = createTradingEnvironment(
      two({
        limits: {
          maximumPositionWeight: 0.3,
          maximumPositionNotional: 20_000,
          maximumGrossLeverage: 1,
        },
      }),
    );
    environment.reset();
    // 400 × 100 = 40,000 = 0.4 of NAV: above the 0.3 weight
    let result = environment.step(order('AAA', 'buy', 400, 'w'));
    expect(result.rejections[0]).toMatchObject({ code: 'environment.limit_breach', orderId: 'w' });
    expect(result.rejections[0]!.detail).toContain('maximumPositionWeight');
    expect(result.fills).toHaveLength(0);
    expect(result.reward.components['riskViolation']!.value).toBe(1);
    // 250 × 101 ≈ 25,250: inside the weight, above the notional
    result = environment.step(order('AAA', 'buy', 250, 'n'));
    expect(result.rejections[0]!.detail).toContain('maximumPositionNotional');
    // inside every limit: filled
    result = environment.step(order('AAA', 'buy', 150, 'a'));
    expect(result.fills.map((f) => f.orderId)).toEqual(['a']);
    expect(result.observation.limits.utilization.map((u) => u.limit)).toEqual([
      'maximumPositionWeight',
      'maximumPositionNotional',
      'maximumGrossLeverage',
    ]);
    const weight = result.observation.limits.utilization[0]!;
    expect(weight.subject).toBe('AAA');
    expect(weight.fraction).toBeCloseTo(weight.value! / 0.3, 12);
    expect(result.observation.limits.breaches).toEqual([]);
    expect(result.terminated).toBe(false);
    // two orders in one action are projected cumulatively: the second tips gross over the leverage line
    const levered = createTradingEnvironment(two({ limits: { maximumGrossLeverage: 0.5 } }));
    levered.reset();
    result = levered.step({
      kind: 'orders',
      orders: [
        { orderId: 'a', instrumentId: 'AAA', side: 'buy', quantity: 150, type: 'market' },
        { orderId: 'b', instrumentId: 'BBB', side: 'buy', quantity: 800, type: 'market' },
      ],
    });
    expect(result.rejections.map((r) => r.orderId)).toEqual(['b']);
    expect(result.rejections[0]!.detail).toContain('maximumGrossLeverage');
    expect(result.fills.map((f) => f.orderId)).toEqual(['a']);
    expect(result.observation.limits.utilization.map((u) => u.limit)).toEqual([
      'maximumGrossLeverage',
    ]);
  });

  it('judges post-trade through the FC7 monitor: a drawdown breach terminates, or is recorded and continues', () => {
    const falling = (
      onBreach?: 'terminate' | 'reject-and-continue',
    ): TradingEnvironmentDefinition => ({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: { AAA: { kind: 'equity', currency: 'USD' } },
      marketData: { bars: bars('AAA', drift(10, 100, -5)) },
      limits: { maximumDrawdown: 0.1, ...(onBreach !== undefined ? { onBreach } : {}) },
    });
    const terminating = createTradingEnvironment(falling());
    terminating.reset();
    let result = terminating.step(order('AAA', 'buy', 900, 'all-in'));
    let steps = 1;
    while (!result.terminated && !result.truncated) {
      result = terminating.step({ kind: 'hold' });
      steps += 1;
    }
    expect(result.terminated).toBe(true);
    expect(result.reason).toBe('limit-breach');
    expect(result.observation.limits.breaches[0]).toMatchObject({
      family: 'drawdown',
      subject: 'portfolio',
    });
    expect(result.observation.limits.breaches[0]!.value).toBeGreaterThan(0.1);
    expect(steps).toBeLessThan(9);
    expect(terminating.step({ kind: 'hold' }).rejections[0]!.code).toBe('environment.episode_over');
    const continuing = createTradingEnvironment(falling('reject-and-continue'));
    continuing.reset();
    result = continuing.step(order('AAA', 'buy', 900, 'all-in'));
    let breaches = 0;
    while (!result.terminated && !result.truncated) {
      result = continuing.step({ kind: 'hold' });
      if (result.observation.limits.breaches.length > 0) breaches += 1;
    }
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('data-boundary');
    expect(breaches).toBeGreaterThan(0);
  });
});

describe('the action mask is a promise', () => {
  it('names why a side is disallowed, and the submission check keeps the promise', () => {
    const environment = createTradingEnvironment(
      two({
        limits: { maximumPositionWeight: 0.2, onBreach: 'reject-and-continue' },
        execution: execution.simplified(),
      }),
    );
    const start = environment.reset();
    expect(start.observation.actionMask['AAA']).toEqual({
      instrumentId: 'AAA',
      buy: true,
      sell: true,
      reasons: { buy: [], sell: [] },
    });
    // fill exactly to the weight: 200 × 101 = 20,200 ≈ 0.2 of NAV after the fill
    let result = environment.step(order('AAA', 'buy', 200, 'fill'));
    expect(result.fills).toHaveLength(1);
    // the projection at 100 passed exactly; the fill at 101 overshoots, and the monitor says so
    expect(result.observation.limits.breaches[0]).toMatchObject({
      family: 'concentration-limit',
      subject: 'instrument AAA',
    });
    expect(result.terminated).toBe(false);
    const mask = result.observation.actionMask['AAA']!;
    expect(mask.buy).toBe(false);
    expect(mask.reasons.buy).toEqual(['position-limit']);
    expect(mask.sell).toBe(true);
    // the mask said no: the buy is rejected as disallowed with that reason, never as a limit breach
    result = environment.step(order('AAA', 'buy', 1, 'more'));
    expect(result.rejections[0]).toMatchObject({
      code: 'environment.action_disallowed',
      orderId: 'more',
    });
    expect(result.rejections[0]!.detail).toContain('position-limit');
    // the mask said yes: the sell is never rejected for a mask reason
    result = environment.step(order('AAA', 'sell', 50, 'trim'));
    expect(result.rejections.filter((r) => r.code === 'environment.action_disallowed')).toEqual([]);
    expect(result.fills).toHaveLength(1);
  });

  it('disallows a naked short option by default, allows it when declared, and a covered call always', () => {
    const journey = portfolioJourneys()['option-assignment']!;
    const definition: Record<string, unknown> = { ...journey };
    delete definition['strategy'];
    const naked = createTradingEnvironment(definition as unknown as TradingEnvironmentDefinition);
    const start = naked.reset();
    expect(start.observation.actionMask['AAA P100']!.sell).toBe(false);
    expect(start.observation.actionMask['AAA P100']!.reasons.sell).toEqual(['undefined-risk']);
    expect(start.observation.actionMask['AAA P100']!.buy).toBe(true);
    const rejected = naked.step(order('AAA P100', 'sell', 1, 'write'));
    expect(rejected.rejections[0]!.code).toBe('environment.action_disallowed');
    expect(rejected.reward.components['riskViolation']!.value).toBe(1);
    const declared = createTradingEnvironment({
      ...(definition as unknown as TradingEnvironmentDefinition),
      limits: { allowUndefinedRiskOptions: true },
    });
    expect(declared.reset().observation.actionMask['AAA P100']!.sell).toBe(true);
    // a call covered by the underlying is not undefined-risk even under the default
    const expiry = dateOf(at(5));
    const covered = createTradingEnvironment({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        'AAA C100': {
          kind: 'option',
          currency: 'USD',
          contractMultiplier: 100,
          contract: {
            kind: 'option',
            underlyingInstrumentId: 'AAA',
            type: 'call',
            strikePricePerUnit: 100,
            expiryTimestampMs: at(5),
          },
        },
      },
      marketData: {
        bars: bars('AAA', flatPath(8, 100)),
        optionChains: Array.from({ length: 8 }, (_, i) => ({
          asOf: at(i),
          underlyingPrice: 100,
          quotes: [
            {
              contract: {
                underlying: 'AAA',
                type: 'call' as const,
                style: 'european' as const,
                strike: 100,
                expiry,
                expiresAt: at(5),
                multiplier: 100,
              },
              timestampMs: at(i),
              mid: 2,
              impliedVolatility: 0.2,
              underlyingPrice: 100,
            },
          ],
        })) as never,
      },
    });
    covered.reset();
    expect(covered.step(order('AAA', 'buy', 100, 'shares')).fills).toHaveLength(1);
    const after = covered.step({ kind: 'hold' });
    expect(after.observation.actionMask['AAA C100']!.sell).toBe(true);
  });

  it('reflects the execution policy: a stale quote under a rejecting policy and a session halt', () => {
    const halted = createTradingEnvironment(
      two({
        execution: execution.declared({
          label: 'test halts',
          sessions: {
            halts: [{ instrumentId: 'BBB', fromTimestampMs: at(1, 0), toTimestampMs: at(1, 23) }],
          },
        }),
      }),
    );
    const start = halted.reset();
    expect(start.observation.actionMask['BBB']!.reasons.buy).toEqual(['halted']);
    expect(start.observation.actionMask['AAA']!.buy).toBe(true);
    const rejected = halted.step(order('BBB', 'buy', 1, 'x'));
    expect(rejected.rejections[0]!.code).toBe('environment.action_disallowed');
    const afterHalt = halted.step({ kind: 'hold' });
    expect(afterHalt.observation.actionMask['BBB']!.buy).toBe(true);
    const stale = createTradingEnvironment({
      ...two(),
      marketData: { bars: [...bars('AAA', drift(12, 100, 1)), ...bars('BBB', drift(3, 50, -1))] },
      execution: execution.declared({
        label: 'test staleness',
        staleQuotes: { maximumAgeMs: 86_400_000, behavior: 'reject' },
      }),
    });
    stale.reset();
    let result = stale.step({ kind: 'hold' });
    for (let i = 0; i < 3; i += 1) result = stale.step({ kind: 'hold' });
    expect(result.observation.freshness['BBB']!.stale).toBe(true);
    expect(result.observation.freshness['BBB']!.ageMs).toBeGreaterThan(86_400_000);
    expect(result.observation.freshness['AAA']!.stale).toBe(false);
    expect(result.observation.actionMask['BBB']!.reasons.buy).toEqual(['stale-quote']);
  });
});

describe('the reward is a declared composition', () => {
  const run = (definition: TradingEnvironmentDefinition) => {
    const environment = createTradingEnvironment(definition);
    environment.reset();
    const steps = [
      environment.step(order('AAA', 'buy', 300, 'a')),
      environment.step(order('BBB', 'buy', 400, 'b')),
      environment.step({ kind: 'hold' }),
      environment.step(order('AAA', 'sell', 100, 'c')),
    ];
    return { steps, result: environment.finish() };
  };

  it('returns every component separately, weight 0 when absent, and never changes the accounting', () => {
    const plain = run(two());
    const paid = run(
      two({ reward: { pnl: 1, drawdown: -2, turnover: -0.1, cost: -1, riskViolation: -10 } }),
    );
    const project = (r: ReturnType<typeof run>) => ({
      fills: r.steps.map((s) => s.fills),
      events: r.steps.map((s) => s.events),
      equity: r.steps.map((s) => s.observation.portfolio.netAssetValue),
      result: canonicalJsonOf({
        ...r.result,
        runId: 'RUN',
        ledger: null,
        events: r.result.events.length,
      }),
    });
    const a = project(plain);
    const b = project(paid);
    expect(canonicalJsonOf(a.fills)).toBe(canonicalJsonOf(b.fills));
    expect(a.equity).toEqual(b.equity);
    expect(a.result.split(plain.result.runId).join('RUN')).toBe(
      b.result.split(paid.result.runId).join('RUN'),
    );
    for (const [i, step] of plain.steps.entries()) {
      const names = Object.keys(step.reward.components);
      expect(names).toEqual([
        'pnl',
        'drawdown',
        'turnover',
        'cost',
        'concentration',
        'leverage',
        'riskViolation',
        'benchmark',
      ]);
      for (const name of names) expect(step.reward.components[name]!.weight).toBe(0);
      expect(step.reward.total).toBe(0);
      const other = paid.steps[i]!.reward;
      for (const name of names)
        expect(other.components[name]!.value).toBe(step.reward.components[name]!.value);
      expect(other.components['pnl']!.weight).toBe(1);
      expect(other.components['pnl']!.contribution).toBe(other.components['pnl']!.value);
      expect(other.total).toBeCloseTo(
        names.reduce((sum, name) => sum + other.components[name]!.contribution, 0),
        12,
      );
    }
    // the first step bought 300 AAA at 101: turnover 30,300 / 100,000
    expect(paid.steps[0]!.reward.components['turnover']!.value).toBeCloseTo(0.303, 12);
    expect(paid.steps[0]!.reward.components['cost']!.value).toBe(0);
    // AAA rises a point a day: the pnl component is the step return of the whole book
    const step2 = paid.steps[2]!;
    expect(step2.reward.components['pnl']!.value).toBeCloseTo(
      step2.observation.portfolio.netAssetValue /
        paid.steps[1]!.observation.portfolio.netAssetValue -
        1,
      12,
    );
    expect(step2.reward.components['concentration']!.value).toBeGreaterThan(0);
    expect(step2.reward.components['leverage']!.value).toBeCloseTo(
      step2.observation.portfolio.grossExposure / step2.observation.portfolio.netAssetValue,
      12,
    );
  });

  it('pays against a benchmark instrument and takes goal terms from a callback', () => {
    const benched = run(
      two({
        reward: {
          benchmark: { weight: 1, instrumentId: 'AAA' },
          goal: (frame) => ({
            fillsCount: frame.fills.length,
            drawdownGap: frame.drawdownAfter - frame.drawdownBefore,
          }),
        },
      }),
    );
    const step = benched.steps[2]!;
    const benchmark = step.reward.components['benchmark']!;
    const closeBefore = benched.steps[1]!.observation.market['AAA']!.bar!.close;
    const closeAfter = step.observation.market['AAA']!.bar!.close;
    expect(closeAfter).toBeGreaterThan(closeBefore);
    expect(benchmark.value).toBeCloseTo(
      step.reward.components['pnl']!.value - (closeAfter / closeBefore - 1),
      12,
    );
    expect(benchmark.weight).toBe(1);
    expect(step.reward.components['fillsCount']).toEqual({ value: 0, weight: 1, contribution: 0 });
    expect(benched.steps[0]!.reward.components['fillsCount']!.value).toBe(1);
    expect(benched.result.assumptions.replayable).toBe(false);
    const bad = createTradingEnvironment(two({ reward: { goal: () => ({ pnl: 1 }) } }));
    bad.reset();
    expect(failure(() => bad.step({ kind: 'hold' })).code).toBe(ErrorCode.InputUnknownField);
    const nan = createTradingEnvironment(two({ reward: { goal: () => ({ x: Number.NaN }) } }));
    nan.reset();
    expect(failure(() => nan.step({ kind: 'hold' })).code).toBe(ErrorCode.InputNotFinite);
  });
});

describe('features and freshness read the prefix only', () => {
  const recipes = {
    lookbackReturns: [1, 5],
    realizedVolatility: { lookbacks: [5], annualization: 252 },
    drawdown: true,
  };

  it('computes lookback returns, realized volatility, and drawdown from bars at or before the instant', () => {
    const environment = createTradingEnvironment(two({ features: recipes }));
    let observation: EnvironmentObservation = environment.reset().observation;
    expect(observation.features.lookbackReturns['1']!['AAA']).toBeNull();
    expect(observation.features.realizedVolatility['5']!['AAA']).toBeNull();
    expect(observation.features.drawdown['AAA']).toBe(0);
    for (let i = 0; i < 6; i += 1) observation = environment.step({ kind: 'hold' }).observation;
    // bar 6: AAA 106, one bar back 105, five back 101; BBB falls a point a day from 50
    expect(observation.features.lookbackReturns['1']!['AAA']).toBeCloseTo(106 / 105 - 1, 12);
    expect(observation.features.lookbackReturns['5']!['AAA']).toBeCloseTo(106 / 101 - 1, 12);
    expect(observation.features.drawdown['AAA']).toBe(0);
    expect(observation.features.drawdown['BBB']).toBeCloseTo(1 - 44 / 50, 12);
    expect(observation.features.realizedVolatility['5']!['AAA']).toBeGreaterThan(0);
    expect(observation.freshness['AAA']).toMatchObject({ ageMs: 0, stale: false, kinds: ['bar'] });
  });

  it('never leaks: every future row perturbed leaves every observation byte-identical (the leakage suite)', () => {
    for (const [name, request] of Object.entries(portfolioJourneys())) {
      const definition: Record<string, unknown> = {
        ...request,
        features: recipes,
        limits: { allowUndefinedRiskOptions: true },
      };
      delete definition['strategy'];
      const base = createTradingEnvironment(definition as unknown as TradingEnvironmentDefinition);
      // the identities legitimately move with the data (they hash every row); the content may not
      let runs: string[] = [];
      const snap = (o: EnvironmentObservation): string =>
        runs.reduce(
          (text, id) => text.split(id).join('RUN'),
          // the instrument specifications are the definition's (a custom adapter carries functions)
          canonicalJsonOf({ ...o, provenance: null, instruments: null }),
        );
      const observations: string[] = [];
      let start = base.reset();
      runs = [start.identity.runId, start.episode.engineRunId];
      const baseRun = start.identity.runId;
      observations.push(snap(start.observation));
      const half = Math.floor(base.instantCount / 2);
      for (let i = 0; i < half; i += 1)
        observations.push(
          snap(
            base.step(
              i === 0
                ? order(Object.keys(request.instruments)[0]!, 'buy', 1, 'one')
                : { kind: 'hold' },
            ).observation,
          ),
        );
      const cutoff = start.observation.asOf + (observations.length - 1) * 86_400_000;
      // perturb every row strictly after the last observed instant
      const perturbed = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
      const marketData = perturbed['marketData'] as Record<string, unknown[]>;
      let touched = 0;
      for (const [key, rows] of Object.entries(marketData)) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows as Record<string, unknown>[]) {
          const stamp = (row['timestampMs'] ?? row['asOf']) as number | undefined;
          const date = (row['exDate'] ?? row['paymentDate'] ?? row['effectiveDate']) as
            | string
            | undefined;
          const after =
            stamp !== undefined
              ? stamp > cutoff
              : date !== undefined
                ? date > dateOf(cutoff)
                : false;
          if (!after) continue;
          touched += 1;
          for (const field of [
            'close',
            'open',
            'high',
            'low',
            'amount',
            'amountPerUnit',
            'fundingRate',
            'forwardRate',
            'quotePerBase',
            'underlyingPrice',
          ])
            if (typeof row[field] === 'number') row[field] = (row[field] as number) * 3 + 7;
          if (key === 'optionChains')
            for (const q of row['quotes'] as Record<string, unknown>[])
              q['mid'] = (q['mid'] as number) * 2 + 1;
        }
      }
      // behavior does not survive JSON: the specifications and the execution policy are the originals
      perturbed['instruments'] = definition['instruments'];
      if (definition['execution'] !== undefined) perturbed['execution'] = definition['execution'];
      const mutant = createTradingEnvironment(perturbed as unknown as TradingEnvironmentDefinition);
      const replay: string[] = [];
      start = mutant.reset();
      runs = [start.identity.runId, start.episode.engineRunId];
      expect(start.identity.runId).not.toBe(baseRun);
      replay.push(snap(start.observation));
      for (let i = 0; i < half; i += 1)
        replay.push(
          snap(
            mutant.step(
              i === 0
                ? order(Object.keys(request.instruments)[0]!, 'buy', 1, 'one')
                : { kind: 'hold' },
            ).observation,
          ),
        );
      expect({
        name,
        touched: touched > 0,
        same: replay.join('\n') === observations.join('\n'),
      }).toEqual({
        name,
        touched: touched > 0,
        same: true,
      });
    }
  });
});

describe('the retry suite', () => {
  it('submitting every action twice adds zero fills, every journey', () => {
    for (const [name, request] of Object.entries(portfolioJourneys())) {
      if (!('onSession' in request.strategy)) continue;
      const strategy = request.strategy;
      const definition: Record<string, unknown> = {
        ...request,
        limits: { allowUndefinedRiskOptions: true },
      };
      delete definition['strategy'];
      const once = createTradingEnvironment(definition as unknown as TradingEnvironmentDefinition);
      const twice = createTradingEnvironment(definition as unknown as TradingEnvironmentDefinition);
      let a = once.reset().observation;
      let b = twice.reset().observation;
      let duplicates = 0;
      while (a.index < once.instantCount - 1) {
        const intents = strategy.onSession({ ...a, observations: a.market } as never);
        const orders = intents.map((o) => {
          const { submittedTimestampMs: _stamp, ...rest } = o;
          return rest;
        });
        const action: EnvironmentAction =
          orders.length > 0 ? { kind: 'orders', orders } : { kind: 'hold' };
        a = once.step(action).observation;
        const first = twice.step(action);
        b = first.observation;
        if (orders.length > 0) {
          // resubmit the same ids at the next step: every one is a duplicate, no fill
          const again = twice.step({ kind: 'orders', orders });
          duplicates += again.rejections.filter(
            (r) => r.code === 'environment.duplicate_order',
          ).length;
          expect(again.fills.filter((f) => orders.some((o) => o.orderId === f.orderId))).toEqual(
            [],
          );
          a = once.step({ kind: 'hold' }).observation;
          b = again.observation;
        }
      }
      expect({ name, sameFinal: a.portfolio.netAssetValue === b.portfolio.netAssetValue }).toEqual({
        name,
        sameFinal: true,
      });
      expect(duplicates).toBeGreaterThan(0);
    }
  });
});

describe('the guards', () => {
  it('teach on every malformed limits, reward, and features block', () => {
    expect(requireEnvironmentLimits('fixture', 'limits', { maximumDrawdown: 0.1 })).toEqual({
      maximumDrawdown: 0.1,
    });
    for (const [limits, code] of [
      [{ maximumDrawdown: 1.5 }, ErrorCode.InputOutOfRange],
      [{ maximumDrawdown: -0.1 }, ErrorCode.InputOutOfRange],
      [{ maximumGrossLeverage: '2' }, ErrorCode.InputWrongType],
      [{ maximumPositionNotional: null }, ErrorCode.InputWrongType],
      [{ allowUndefinedRiskOptions: 'yes' }, ErrorCode.InputWrongType],
      [{ onBreach: 'ignore' }, ErrorCode.InputInvalidEnum],
      [{ extra: 1 }, ErrorCode.InputUnknownField],
      [{ maximumGroupWeights: {} }, ErrorCode.InputWrongType],
    ] as const) {
      expect(failure(() => requireEnvironmentLimits('fixture', 'limits', limits)).code).toBe(code);
    }
    expect(requireRewardComposition('fixture', 'reward', { pnl: 1 })).toEqual({ pnl: 1 });
    for (const [reward, code] of [
      [{ pnl: Number.POSITIVE_INFINITY }, ErrorCode.InputNotFinite],
      [{ pnl: null }, ErrorCode.InputWrongType],
      [{ benchmark: { weight: 1 } }, ErrorCode.InputWrongType],
      [{ benchmark: { weight: 1, instrumentId: 'AAA', extra: 1 } }, ErrorCode.InputUnknownField],
      [{ goal: 'x' }, ErrorCode.InputWrongType],
      [{ sharpe: 1 }, ErrorCode.InputUnknownField],
    ] as const) {
      expect(failure(() => requireRewardComposition('fixture', 'reward', reward)).code).toBe(code);
    }
    expect(requireFeatureRecipes('fixture', 'features', { drawdown: true })).toEqual({
      drawdown: true,
    });
    for (const [features, code] of [
      [{ lookbackReturns: [] }, ErrorCode.InputOutOfRange],
      [{ lookbackReturns: [0] }, ErrorCode.InputOutOfRange],
      [{ lookbackReturns: [1.5] }, ErrorCode.InputOutOfRange],
      [{ lookbackReturns: [2 ** 32] }, ErrorCode.BacktestInputTooLarge],
      [
        { realizedVolatility: { lookbacks: [100_001], annualization: 252 } },
        ErrorCode.BacktestInputTooLarge,
      ],
      [{ lookbackReturns: 5 }, ErrorCode.InputWrongType],
      [{ realizedVolatility: { lookbacks: [5], annualization: 0 } }, ErrorCode.InputOutOfRange],
      [{ realizedVolatility: { lookbacks: [5], window: 1 } }, ErrorCode.InputUnknownField],
      [{ drawdown: 1 }, ErrorCode.InputWrongType],
    ] as const) {
      expect(failure(() => requireFeatureRecipes('fixture', 'features', features)).code).toBe(code);
    }
    // through the definition door
    expect(failure(() => createTradingEnvironment(two({ limits: null } as never))).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() =>
        createTradingEnvironment(
          two({ reward: { benchmark: { weight: 1, instrumentId: 'ZZZ' } } }),
        ),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => createTradingEnvironment(two({ features: { drawdown: 'yes' } } as never))).code,
    ).toBe(ErrorCode.InputWrongType);
  });
});

void (0 as unknown as Bar);
