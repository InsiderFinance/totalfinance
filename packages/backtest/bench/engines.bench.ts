import { bench, describe } from 'vitest';
import type { Bar } from '@totalfinance/core';
import {
  type StrategyContext,
  brokers,
  eventDriven,
  fees,
  vectorized,
} from '@totalfinance/backtest';

/**
 * Phase-5 acceleration-need benchmark for the backtest engines (§19.4 candidate).
 *
 * Repaired at 3B.1b: it imported a `backtest` namespace that does not exist (the engines are
 * top-level `vectorized`/`eventDriven`), used `Bar.ts` (renamed `timestampMs`), and left the strategy
 * context implicitly `any`. None of it compiled, and nothing said so — `*.bench.ts` was outside both
 * `pnpm run ci` and `typecheck` until this change.
 */
const N = 2000;
const data: Bar[] = Array.from({ length: N }, (_, i) => {
  const c = 100 * Math.exp(0.0002 * i + 0.02 * Math.sin(i / 12));
  return { symbol: 'X', timestampMs: i * 86_400_000, open: c, high: c, low: c, close: c };
});

describe('backtest engines (acceleration-need benchmark)', () => {
  const signal = data.map((_, i) => i % 5 < 3);

  bench('vectorized 2k bars (weekly rebalance + costs)', () => {
    vectorized({ data, signal, rebalance: 'weekly', fees: fees.bps(1) });
  });

  bench('event-driven 2k bars (buy-and-hold strategy)', () => {
    eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000, commission: fees.bps(1) }),
      strategy(ctx: StrategyContext) {
        let entered = false;
        ctx.onBar('X', () => {
          if (!entered) {
            entered = true;
            ctx.buy('X', { percent: 1 });
          }
        });
      },
    });
  });
});
