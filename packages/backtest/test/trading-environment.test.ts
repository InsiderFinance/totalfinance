/**
 * Stage 7B.1 slice 1 — `createTradingEnvironment`: reset/step over the stepper seam; the
 * next-observation law; open orders that carry, cancel, and replace; idempotent retry; typed
 * rejections that never throw; terminated/truncated; the trace identity; the guards; immutability;
 * and the equivalence with `portfolioBacktest` under a one-instant order shift.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { execution } from '@totalfinance/backtest/execution';
import { portfolioBacktest, type PortfolioBacktestRequest } from '@totalfinance/backtest/portfolio';
import {
  MAXIMUM_ENVIRONMENT_STEPS,
  RATIONALE_BYTE_LIMIT,
  createTradingEnvironment,
  requireEnvironmentAction,
  requireEnvironmentOrder,
  requireTradingEnvironmentDefinition,
  type EnvironmentAction,
  type TradingEnvironmentDefinition,
} from '@totalfinance/backtest/environment';
import { at, bars, drift, equityRequest, portfolioJourneys } from './portfolio-journeys.js';

const definitionOf = (request: PortfolioBacktestRequest): TradingEnvironmentDefinition => {
  const rest: Record<string, unknown> = { ...request };
  delete rest['strategy'];
  return rest as unknown as TradingEnvironmentDefinition;
};
const DEFINITION = (): TradingEnvironmentDefinition => definitionOf(equityRequest());
const buy = (quantity: number, orderId?: string): EnvironmentAction => ({
  kind: 'orders',
  orders: [
    {
      ...(orderId !== undefined ? { orderId } : {}),
      instrumentId: 'AAA',
      side: 'buy',
      quantity,
      type: 'market',
    },
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

describe('reset and step', () => {
  it('positions the episode at the first instant and steps through the data', () => {
    const environment = createTradingEnvironment(DEFINITION());
    expect(environment.instantCount).toBe(10);
    const start = environment.reset();
    expect(start.observation.index).toBe(0);
    expect(start.observation.sequence).toBe(0);
    expect(start.observation.asOf).toBe(at(0));
    expect(start.observation.portfolio.netAssetValue).toBe(100_000);
    expect(start.observation.portfolio.positions).toEqual([]);
    expect(start.observation.portfolio.openOrders).toEqual([]);
    expect(start.observation.previous).toBeNull();
    expect(start.observation.market['AAA']?.bar?.close).toBe(100);
    expect(start.episode).toMatchObject({ instantCount: 10, maximumSteps: 10, seed: null });
    expect(start.identity.step).toBe(0);
    let result = environment.step(buy(100, 'first'));
    // the next-observation law: decided on bar 0 (close 100), filled on bar 1 (close 101)
    expect(result.observation.index).toBe(1);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.pricePerUnit).toBe(101);
    expect(result.observation.portfolio.positions[0]).toMatchObject({
      instrumentId: 'AAA',
      quantity: 100,
      baseCurrencyMarketValue: 10_100,
    });
    expect(result.observation.portfolio.grossExposure).toBe(10_100);
    expect(result.observation.portfolio.netExposure).toBe(10_100);
    expect(result.observation.previous?.action).toEqual(buy(100, 'first'));
    expect(result.observation.previous?.fills).toHaveLength(1);
    expect(result.terminated).toBe(false);
    expect(result.truncated).toBe(false);
    for (let i = 2; i < 10; i += 1) result = environment.step({ kind: 'hold' });
    expect(result.observation.index).toBe(9);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('data-boundary');
    expect(result.identity.step).toBe(9);
    // the episode is over: a further step is a rejection row, the observation unchanged
    const over = environment.step({ kind: 'hold' });
    expect(over.rejections[0]!.code).toBe('environment.episode_over');
    expect(over.observation).toBe(result.observation);
    expect(over.identity).toEqual(result.identity);
    const outcome = environment.finish();
    expect(outcome.diagnostics.sessionCount).toBe(10);
    expect(outcome.fills).toHaveLength(1);
    expect(outcome.assumptions.strategy).toEqual({ kind: 'external', replayable: false });
    expect(environment.step({ kind: 'hold' }).rejections[0]!.detail).toContain('finish()');
  });

  it('equals portfolioBacktest without adding a second observation of delay', () => {
    for (const [name, request] of Object.entries(portfolioJourneys())) {
      if (!('onSession' in request.strategy)) continue;
      const strategy = request.strategy;
      // the journeys write options and lever up: the environment's safety defaults are lifted so the
      // comparison is the engine's, not the mask's
      const environment = createTradingEnvironment({
        ...definitionOf(request),
        limits: { allowUndefinedRiskOptions: true },
      });
      let state = environment.reset().observation;
      const submitted: string[] = [];
      for (let step = 1; state.index < environment.instantCount - 1; step += 1) {
        // the journey's callback decides at index 0; the environment decides on observation 0 and fills at 1
        const intents = strategy.onSession({
          ...state,
          observations: state.market,
          index: state.index,
        } as never);
        const orders = intents.map((o) => {
          submitted.push(o.orderId);
          const { submittedTimestampMs: _stamp, ...rest } = o;
          return rest;
        });
        const result = environment.step(
          orders.length > 0 ? { kind: 'orders', orders } : { kind: 'hold' },
        );
        state = result.observation;
      }
      const viaEnvironment = environment.finish();
      const shifted = portfolioBacktest(request);
      const project = (r: typeof shifted): string => {
        const clone = JSON.parse(canonicalJsonOf(r)) as { assumptions: Record<string, unknown> };
        delete clone.assumptions['strategy'];
        return canonicalJsonOf(clone)
          .split(r.runId)
          .join('RUN')
          .split('createPortfolioStepper: ')
          .join('portfolioBacktest: ');
      };
      expect({ name, same: project(viaEnvironment) === project(shifted) }).toEqual({
        name,
        same: true,
      });
    }
  });

  it('carries an unfilled gtc limit order, expires a day order, cancels and replaces, and never double-executes', () => {
    const environment = createTradingEnvironment(DEFINITION());
    environment.reset();
    // a limit far below the market: not triggered on bar 1 (close 101)
    let result = environment.step({
      kind: 'orders',
      orders: [
        {
          orderId: 'gtc',
          instrumentId: 'AAA',
          side: 'buy',
          quantity: 10,
          type: 'limit',
          limitPrice: 50,
          timeInForce: 'gtc',
        },
        {
          orderId: 'day',
          instrumentId: 'AAA',
          side: 'buy',
          quantity: 10,
          type: 'limit',
          limitPrice: 50,
          timeInForce: 'day',
        },
      ],
    });
    expect(result.fills).toHaveLength(0);
    expect(result.rejections.map((r) => r.code)).toEqual([
      'backtest.unfilled.not-triggered',
      'backtest.unfilled.not-triggered',
    ]);
    expect(result.diagnostics.carriedCount).toBe(1);
    expect(result.observation.portfolio.openOrders).toHaveLength(1);
    expect(result.observation.portfolio.openOrders[0]).toMatchObject({
      orderId: 'gtc',
      reason: 'not-triggered',
      attempts: 1,
      quantity: 10,
    });
    // the day order is gone; resubmitting its id is a duplicate
    result = environment.step({
      kind: 'orders',
      orders: [{ orderId: 'day', instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' }],
    });
    expect(result.rejections[0]).toMatchObject({
      code: 'environment.duplicate_order',
      orderId: 'day',
    });
    expect(result.rejections[0]!.detail).toContain('unfilled');
    expect(result.observation.portfolio.openOrders[0]!.attempts).toBe(2);
    // replace: cancel the resting limit and submit a market order in the same action
    result = environment.step({
      kind: 'orders',
      cancel: ['gtc'],
      orders: [{ orderId: 'mkt', instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' }],
    });
    expect(result.diagnostics.cancelledCount).toBe(1);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.orderId).toBe('mkt');
    expect(result.observation.portfolio.openOrders).toHaveLength(0);
    // cancelling an id that is not open is a typed rejection; a retry of 'mkt' is a duplicate
    result = environment.step({
      kind: 'orders',
      cancel: ['gtc'],
      orders: [{ orderId: 'mkt', instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' }],
    });
    expect(result.rejections.map((r) => r.code)).toEqual([
      'environment.order_invalid',
      'environment.duplicate_order',
    ]);
    expect(result.fills).toHaveLength(0);
    const outcome = environment.finish();
    expect(outcome.fills).toHaveLength(1);
    expect(outcome.orders.filter((o) => o.orderId === 'gtc')).toHaveLength(2);
  });

  it('rejects malformed actions and orders as rows — the step proceeds as hold', () => {
    const environment = createTradingEnvironment(DEFINITION());
    environment.reset();
    const cases: Array<[unknown, string]> = [
      [{ kind: 'buy' }, 'environment.action_invalid'],
      [{ kind: 'hold', extra: 1 }, 'environment.action_invalid'],
      [{ kind: 'orders' }, 'environment.action_invalid'],
      [{ kind: 'orders', orders: [null] }, 'environment.action_invalid'],
      [{ kind: 'orders', orders: [], cancel: [''] }, 'environment.action_invalid'],
      [{ kind: 'hold', rationale: 7 }, 'environment.action_invalid'],
    ];
    for (const [action, code] of cases) {
      const result = environment.step(action as EnvironmentAction);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]!.code).toBe(code);
      expect(result.rejections[0]!.detail).toContain('hold');
      expect(result.fills).toHaveLength(0);
    }
    const orders = environment.step({
      kind: 'orders',
      orders: [
        { instrumentId: 'ZZZ', side: 'buy', quantity: 1, type: 'market' },
        { instrumentId: 'AAA', side: 'buy', quantity: -1, type: 'market' },
        { instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'limit' },
        { instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'market', limitPrice: 5 } as never,
        { instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'market', extra: 1 } as never,
        { instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'market' },
      ],
    });
    expect(orders.rejections.map((r) => r.code)).toEqual([
      'environment.unknown_instrument',
      'environment.order_invalid',
      'environment.order_invalid',
      'environment.order_invalid',
      'environment.order_invalid',
    ]);
    expect(orders.rejections[1]!.detail).toContain('quantity');
    expect(orders.rejections[2]!.detail).toContain('limitPrice');
    expect(orders.diagnostics.acceptedCount).toBe(1);
    expect(orders.fills).toHaveLength(1);
    expect(orders.fills[0]!.orderId).toMatch(/:a1$/);
    // a non-object step argument is the one refusal
    expect(failure(() => environment.step(null as never)).code).toBe(ErrorCode.InputWrongType);
    expect(failure(() => environment.step('hold' as never)).code).toBe(ErrorCode.InputWrongType);
  });

  it('keeps the rationale as metadata, bounded, and never reads it', () => {
    const a = createTradingEnvironment(DEFINITION());
    const b = createTradingEnvironment(DEFINITION());
    a.reset();
    b.reset();
    const long = 'x'.repeat(RATIONALE_BYTE_LIMIT + 10);
    const withText = a.step({ ...buy(5, 'o'), rationale: long });
    const without = b.step(buy(5, 'o'));
    expect(withText.diagnostics.rationaleTruncated).toBe(true);
    expect(without.diagnostics.rationaleTruncated).toBe(false);
    expect(withText.fills).toEqual(without.fills);
    expect(withText.observation.portfolio).toEqual(without.observation.portfolio);
    // the rationale is part of the trace, so the identities differ; the accounting does not
    expect(withText.identity.traceHash).not.toBe(without.identity.traceHash);
    expect(withText.identity.runId).toBe(without.identity.runId);
    const recorded = withText.observation.previous?.action as { rationale?: string };
    expect(recorded.rationale?.length).toBe(RATIONALE_BYTE_LIMIT);
  });

  it('is deterministic: the same actions leave the same trace, fills, and result; the seed is identity', () => {
    const run = (seed?: number) => {
      const environment = createTradingEnvironment(DEFINITION());
      const start = environment.reset(seed === undefined ? undefined : { seed });
      const steps = [
        environment.step(buy(10, 'a')),
        environment.step({ kind: 'hold' }),
        environment.step(buy(5, 'b')),
      ];
      return { start, steps, result: environment.finish() };
    };
    const x = run();
    const y = run();
    expect(canonicalJsonOf(x)).toBe(canonicalJsonOf(y));
    expect(x.steps[2]!.identity.traceHash).toBe(y.steps[2]!.identity.traceHash);
    const z = run(7);
    expect(z.start.episode.seed).toBe(7);
    expect(z.start.identity.runId).not.toBe(x.start.identity.runId);
    expect(z.result.finalValue).toBe(x.result.finalValue);
    // reset again starts a fresh episode with the same identity
    const environment = createTradingEnvironment(DEFINITION());
    const first = environment.reset();
    environment.step(buy(10, 'a'));
    const second = environment.reset();
    expect(second.identity).toEqual(first.identity);
    expect(second.observation.portfolio.positions).toEqual([]);
  });

  it('terminates when the equity is exhausted and truncates at maximumSteps', () => {
    const crash = createTradingEnvironment({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 10_000 }] },
      instruments: { AAA: { kind: 'equity', currency: 'USD' } },
      marketData: { bars: bars('AAA', drift(6, 100, -30)) },
      execution: execution.declared({
        label: 'test leverage',
        margin: {
          buyingPowerMultiplier: 4,
          initialMarginRate: 0.25,
          maintenanceMarginRate: 0.1,
          forcedLiquidation: 'none',
        },
      }),
    });
    crash.reset();
    let result = crash.step(buy(300, 'lev'));
    while (!result.terminated && !result.truncated) result = crash.step({ kind: 'hold' });
    expect(result.terminated).toBe(true);
    expect(result.reason).toBe('insolvent');
    expect(result.observation.portfolio.netAssetValue).toBeLessThanOrEqual(0);
    const bounded = createTradingEnvironment({ ...DEFINITION(), maximumSteps: 2 });
    const start = bounded.reset();
    expect(start.episode.maximumSteps).toBe(2);
    bounded.step({ kind: 'hold' });
    const last = bounded.step({ kind: 'hold' });
    expect(last.truncated).toBe(true);
    expect(last.reason).toBe('maximum-steps');
    expect(bounded.step({ kind: 'hold' }).rejections[0]!.code).toBe('environment.episode_over');
  });

  it('freezes observations and results', () => {
    const environment = createTradingEnvironment(DEFINITION());
    const start = environment.reset();
    expect(Object.isFrozen(start)).toBe(true);
    expect(Object.isFrozen(start.observation.portfolio)).toBe(true);
    expect(Object.isFrozen(start.observation.market['AAA'])).toBe(true);
    const result = environment.step(buy(1, 'x'));
    expect(Object.isFrozen(result.fills)).toBe(true);
    expect(Object.isFrozen(result.observation.portfolio.positions[0])).toBe(true);
    expect(Object.isFrozen(environment)).toBe(true);
  });
});

describe('the guards', () => {
  it('refuse step() and finish() before reset(), and teach on every malformed definition', () => {
    const environment = createTradingEnvironment(DEFINITION());
    expect(failure(() => environment.step({ kind: 'hold' })).code).toBe(
      ErrorCode.EnvironmentNotReset,
    );
    expect(failure(() => environment.finish()).code).toBe(ErrorCode.EnvironmentNotReset);
    expect(failure(() => createTradingEnvironment(null as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() => createTradingEnvironment({ ...DEFINITION(), strategy: {} } as never)).message,
    ).toContain('portfolioBacktest');
    expect(
      failure(() => createTradingEnvironment({ ...DEFINITION(), extra: 1 } as never)).code,
    ).toBe(ErrorCode.InputUnknownField);
    for (const [steps, code] of [
      [0, ErrorCode.InputOutOfRange],
      [1.5, ErrorCode.InputOutOfRange],
      ['5', ErrorCode.InputWrongType],
      [null, ErrorCode.InputWrongType],
      [MAXIMUM_ENVIRONMENT_STEPS + 1, ErrorCode.BacktestInputTooLarge],
    ] as const) {
      expect(
        failure(() => createTradingEnvironment({ ...DEFINITION(), maximumSteps: steps } as never))
          .code,
      ).toBe(code);
    }
    expect(
      failure(() =>
        createTradingEnvironment({
          ...DEFINITION(),
          window: { fromTimestampMs: at(50), toTimestampMs: at(60) },
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(failure(() => environment.reset({ seed: -1 })).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(() => environment.reset({ seed: '1' as never })).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(failure(() => environment.reset({ extra: 1 } as never)).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(() => environment.reset(7 as never)).code).toBe(ErrorCode.InputWrongType);
    expect(
      requireTradingEnvironmentDefinition('fixture', 'definition', DEFINITION()),
    ).toMatchObject({
      accounting: { baseCurrency: 'USD' },
    });
  });

  it('requireEnvironmentAction and requireEnvironmentOrder refuse outright with the teaching text', () => {
    expect(requireEnvironmentAction('fixture', 'action', { kind: 'hold' })).toEqual({
      kind: 'hold',
    });
    expect(
      failure(() => requireEnvironmentAction('fixture', 'action', { kind: 'sell' })).code,
    ).toBe(ErrorCode.InputWrongShape);
    expect(failure(() => requireEnvironmentAction('fixture', 'action', null)).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() =>
        requireEnvironmentAction('fixture', 'action', {
          kind: 'orders',
          orders: [{ instrumentId: 'AAA', side: 'buy', quantity: 0, type: 'market' }],
        }),
      ).message,
    ).toContain('action.orders[0].quantity');
    expect(
      requireEnvironmentOrder('fixture', 'order', {
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 1,
        type: 'market',
      }),
    ).toEqual({ instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'market' });
    expect(
      failure(() => requireEnvironmentOrder('fixture', 'order', { instrumentId: 'AAA' })).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        requireEnvironmentOrder('fixture', 'order', {
          instrumentId: 'AAA',
          side: 'buy',
          quantity: 1,
          type: 'market',
          submittedTimestampMs: 1,
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
  });
});
