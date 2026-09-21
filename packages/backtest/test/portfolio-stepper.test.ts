/**
 * Stage 7B.1 slice 1 — the stepper seam (Decision 2): `portfolioBacktest` matches the reviewed
 * causal-execution goldens; a stepper driven by hand reproduces every callback journey;
 * the sequencing law refuses out-of-order calls and changes nothing; `finish()` reports the instants
 * closed so far; the guard teaches; the stepper is frozen.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf, contentHash } from '@totalfinance/core/artifacts';
import {
  createPortfolioStepper,
  portfolioBacktest,
  requirePortfolioStepperRequest,
  type PortfolioBacktestRequest,
  type PortfolioBacktestResult,
  type PortfolioStepperRequest,
} from '@totalfinance/backtest/portfolio';
import type { OrderIntent } from '@totalfinance/backtest/execution';
import { equityRequest, portfolioJourneys } from './portfolio-journeys.js';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./portfolio-golden.json', import.meta.url), 'utf8'),
) as Record<
  string,
  { hash: string; finalValue: number; sessions: number; fills: number; events: number }
>;

const withoutStrategy = (request: PortfolioBacktestRequest): PortfolioStepperRequest => {
  const rest: Record<string, unknown> = { ...request };
  delete rest['strategy'];
  return rest as unknown as PortfolioStepperRequest;
};

/** The result with its run identity and the strategy description projected out. */
const normalized = (result: PortfolioBacktestResult): string => {
  const clone = JSON.parse(canonicalJsonOf(result)) as { assumptions: Record<string, unknown> };
  delete clone.assumptions['strategy'];
  // the engine names its caller in warnings and refusals; the stepper's caller is the stepper
  return canonicalJsonOf(clone)
    .split(result.runId)
    .join('RUN')
    .split('createPortfolioStepper: ')
    .join('portfolioBacktest: ');
};

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('portfolioBacktest through the seam', () => {
  it('matches the reviewed causal-execution goldens, every journey', () => {
    const journeys = portfolioJourneys();
    expect(Object.keys(journeys).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [name, request] of Object.entries(journeys)) {
      const result = portfolioBacktest(request);
      expect({ name, hash: contentHash(result) }).toEqual({ name, hash: GOLDEN[name]!.hash });
      expect(result.finalValue).toBe(GOLDEN[name]!.finalValue);
      expect(result.diagnostics.sessionCount).toBe(GOLDEN[name]!.sessions);
      expect(result.fills).toHaveLength(GOLDEN[name]!.fills);
      expect(result.events).toHaveLength(GOLDEN[name]!.events);
    }
  });
});

describe('the stepper driven by hand', () => {
  it('reproduces every callback journey — the same fills, events, marks, equity, and reports', () => {
    for (const [name, request] of Object.entries(portfolioJourneys())) {
      if (!('onSession' in request.strategy)) continue;
      const expected = portfolioBacktest(request);
      const stepper = createPortfolioStepper(withoutStrategy(request));
      expect(stepper.instants).toHaveLength(expected.diagnostics.sessionCount);
      let pending: readonly OrderIntent[] = [];
      for (let index = 0; index < stepper.instants.length; index += 1) {
        const context = stepper.open(index);
        expect(context.asOf).toBe(stepper.instants[index]);
        expect(context.index).toBe(index);
        stepper.close(index, pending);
        pending =
          index + 1 < stepper.instants.length ? request.strategy.onSession(stepper.context()) : [];
      }
      const actual = stepper.finish();
      expect({ name, same: normalized(actual) === normalized(expected) }).toEqual({
        name,
        same: true,
      });
      expect(actual.assumptions.strategy).toEqual({ kind: 'external', replayable: false });
      expect(actual.assumptions.replayable).toBe(false);
    }
  });

  it('returns the rows each step appended, and the identity is stable', () => {
    const request = withoutStrategy(equityRequest());
    const a = createPortfolioStepper(request);
    const b = createPortfolioStepper(request);
    expect(a.runId).toBe(b.runId);
    expect(a.runId).not.toBe(portfolioBacktest(equityRequest()).runId);
    const context = a.open(0);
    a.close(0, []);
    a.open(1);
    const frame = a.close(1, [
      {
        orderId: 'buy',
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 100,
        type: 'market',
        submittedTimestampMs: context.asOf,
      },
    ]);
    expect(frame.index).toBe(1);
    expect(frame.asOf).toBe(a.instants[1]);
    expect(frame.fills).toHaveLength(1);
    expect(frame.orders[0]).toMatchObject({
      orderId: 'buy',
      source: 'strategy',
      outcome: 'filled',
    });
    expect(frame.events.some((e) => e.eventType === 'trade.fill')).toBe(true);
    expect(Number.isFinite(frame.netAssetValue)).toBe(true);
    const quiet = a.close(2, (a.open(2), []));
    expect(quiet.fills).toHaveLength(0);
    expect(quiet.orders).toHaveLength(0);
    expect(quiet.events).toHaveLength(0);
    // an unknown instrument is a rejection row, never a throw — the engine's own law
    const rejected = a.close(
      3,
      (a.open(3),
      [
        {
          orderId: 'x',
          instrumentId: 'ZZZ',
          side: 'buy',
          quantity: 1,
          type: 'market',
          submittedTimestampMs: a.instants[3]!,
        },
      ]),
    );
    expect(rejected.rejections).toHaveLength(1);
    expect(rejected.rejections[0]!.code).toBe('backtest.universe_membership_unknown');
  });

  it('finish() reports the instants closed so far — an episode may stop early', () => {
    const stepper = createPortfolioStepper(withoutStrategy(equityRequest()));
    expect(stepper.instants).toHaveLength(10);
    for (let index = 0; index < 3; index += 1) stepper.close(index, (stepper.open(index), []));
    const result = stepper.finish();
    expect(result.diagnostics.sessionCount).toBe(3);
    expect(result.points).toHaveLength(4);
    expect(result.finalValue).toBe(100_000);
    expect(result.diagnostics.markCount).toBe(3);
  });

  it('refuses out-of-order calls and changes nothing', () => {
    const stepper = createPortfolioStepper(withoutStrategy(equityRequest()));
    expect(failure(() => stepper.close(0, [])).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(() => stepper.open(1)).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(() => stepper.open('0' as never)).code).toBe(ErrorCode.InputWrongType);
    stepper.open(0);
    expect(failure(() => stepper.open(0)).code).toBe(ErrorCode.InputWrongShape);
    expect(failure(() => stepper.open(1)).code).toBe(ErrorCode.InputWrongShape);
    expect(failure(() => stepper.finish()).code).toBe(ErrorCode.InputWrongShape);
    expect(failure(() => stepper.close(1, [])).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(() => stepper.close(0, 'buy' as never)).code).toBe(ErrorCode.InputWrongType);
    expect(failure(() => stepper.close(0, [{ orderId: 'x' } as never])).message).toContain(
      'orders[0]',
    );
    stepper.close(0, []);
    expect(failure(() => stepper.close(0, [])).code).toBe(ErrorCode.InputOutOfRange);
    for (let index = 1; index < stepper.instants.length; index += 1)
      stepper.close(index, (stepper.open(index), []));
    expect(failure(() => stepper.open(stepper.instants.length)).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    const result = stepper.finish();
    expect(result.diagnostics.sessionCount).toBe(10);
    expect(failure(() => stepper.open(0)).code).toBe(ErrorCode.InputWrongShape);
    // finish() again is the same result, not a second run
    expect(stepper.finish()).toBe(result);
  });

  it('is frozen, and its instants are frozen', () => {
    const stepper = createPortfolioStepper(withoutStrategy(equityRequest()));
    expect(Object.isFrozen(stepper)).toBe(true);
    expect(Object.isFrozen(stepper.instants)).toBe(true);
  });

  it('teaches on every malformed request', () => {
    const base = withoutStrategy(equityRequest());
    expect(failure(() => createPortfolioStepper(null as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(failure(() => createPortfolioStepper([] as never)).code).toBe(ErrorCode.InputWrongType);
    const withStrategy = failure(() =>
      createPortfolioStepper({ ...base, strategy: equityRequest().strategy } as never),
    );
    expect(withStrategy.code).toBe(ErrorCode.InputUnknownField);
    expect(withStrategy.message).toContain('portfolioBacktest');
    expect(failure(() => createPortfolioStepper({ ...base, extra: 1 } as never)).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(() => createPortfolioStepper({ ...base, accounting: null } as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
    const noAccounting: Record<string, unknown> = { ...base };
    delete noAccounting['accounting'];
    expect(failure(() => createPortfolioStepper(noAccounting as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() => requirePortfolioStepperRequest('fixture', 'request', 7)).message,
    ).toContain('request');
    expect(requirePortfolioStepperRequest('fixture', 'request', base)).toBe(base);
  });
});
