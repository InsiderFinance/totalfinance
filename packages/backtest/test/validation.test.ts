/**
 * Regression tests for the "fail loudly on impossible inputs" hardening (PR review): impossible-price
 * bars, soft strategy sizing, broker order/config validation, and non-finite vectorized signals.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import type { Bar } from '@totalfinance/core';
import {
  type OrderType,
  type TimeInForce,
  SimulatedBroker,
  brokers,
  walkForward,
} from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const bar = (i: number, o: number, h: number, l: number, c: number, symbol = 'X'): Bar => ({
  symbol,
  timestampMs: i * DAY,
  open: o,
  high: h,
  low: l,
  close: c,
});
const flat = (i: number, p: number, symbol = 'X'): Bar => bar(i, p, p, p, p, symbol);
const twoBars = [flat(0, 100), flat(1, 101)];

describe('[P1] impossible-price bars are rejected (no fabricated fills)', () => {
  it('event-driven throws on a negative-price bar instead of filling at it', () => {
    const data = [flat(0, 100), bar(1, -10, -10, -10, -10)];
    expect(() =>
      backtest.eventDriven({
        data,
        broker: brokers.simulated({ cash: 1000 }),
        strategy(context) {
          context.onBar('X', () => context.buy('X', { quantity: 10 }));
        },
      }),
    ).toThrow(/positive finite/);
  });

  it('broker.processBar rejects inconsistent OHLC (high < max(open, close))', () => {
    const b = brokers.simulated({ cash: 1000 });
    expect(() =>
      b.processBar({ symbol: 'X', timestampMs: 0, open: 100, high: 90, low: 95, close: 100 }),
    ).toThrow(/inconsistent/);
  });

  it('broker.processBar rejects a non-finite price', () => {
    const b = brokers.simulated({ cash: 1000 });
    expect(() =>
      b.processBar({ symbol: 'X', timestampMs: 0, open: 100, high: 100, low: 100, close: NaN }),
    ).toThrow(/positive finite/);
  });
});

describe('[P2] strategy sizing rejects invalid values', () => {
  const run = (options: { quantity?: number; value?: number; percent?: number }) =>
    backtest.eventDriven({
      data: twoBars,
      broker: brokers.simulated({ cash: 1000 }),
      strategy(context) {
        context.onBar('X', () => context.buy('X', options));
      },
    });

  it('non-positive quantity / value throw rather than silently no-op', () => {
    expect(() => run({ quantity: 0 })).toThrow(/quantity/);
    expect(() => run({ value: -5 })).toThrow(/value/);
  });

  it('a negative percent throws rather than reversing direction into a short', () => {
    expect(() => run({ percent: -1 })).toThrow(/percent/);
  });
});

describe('[P2] broker order & config validation', () => {
  it('rejects unknown order type and TIF', () => {
    const b = brokers.simulated({ cash: 1000 });
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 1, type: 'bogus' as OrderType }),
    ).toThrow(/type/);
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 1, timeInForce: 'bogus' as TimeInForce }),
    ).toThrow(/timeInForce/);
  });

  it('rejects non-positive trigger / bracket prices', () => {
    const b = brokers.simulated({ cash: 1000 });
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 1, type: 'limit', limitPrice: -5 }),
    ).toThrow(/limitPrice/);
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 1, type: 'stop', stopPrice: 0 }),
    ).toThrow(/stopPrice/);
  });

  it('rejects non-positive config knobs', () => {
    expect(() => brokers.simulated({ cash: 1000, maxVolumeParticipation: 0 })).toThrow(
      /maxVolumeParticipation/,
    );
    expect(() => brokers.simulated({ cash: 1000, maxLeverage: -1 })).toThrow(/maxLeverage/);
  });

  it('still accepts the no-cap defaults (maxLeverage / participation = Infinity)', () => {
    expect(() => brokers.simulated({ cash: 1000 })).not.toThrow();
  });
});

describe('[P2] vectorized rejects a non-finite numeric signal', () => {
  it('throws on a NaN weight rather than silently skipping a rebalance', () => {
    const data = [flat(0, 100), flat(1, 101), flat(2, 102)];
    expect(() => backtest.vectorized({ data, signal: [0.5, NaN, 1] })).toThrow(/signal\[1\]/);
  });
});

describe('engine boundary shape guards (dx §1.1)', () => {
  it('vectorized({ close, signal }) teaches the data shape instead of a raw TypeError', () => {
    let caught: unknown;
    try {
      backtest.vectorized({ close: [1, 2, 3], signal: [0, 1, 1] } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof TypeError).toBe(false);
    expect((caught as Error).message).toContain('data: Bar[]');
    expect((caught as Error).message).toContain('received keys: close, signal');
  });

  it("vectorized's shape string teaches the REAL capital option, not a nonexistent one", () => {
    let caught: unknown;
    try {
      backtest.vectorized({ close: [1, 2, 3] } as never);
    } catch (e) {
      caught = e;
    }
    // 'initialCash?' used to be taught here — a field that does not exist on VectorizedOptions.
    expect((caught as Error).message).toContain('initialCapital?');
    expect((caught as Error).message).not.toContain('initialCash');
  });

  it('eventDriven and walkForward guard the same way', () => {
    expect(() => backtest.eventDriven({} as never)).toThrowError(/data: Bar\[\]/);
    expect(() => walkForward({ data: 'nope' } as never)).toThrowError(/data: Bar\[\]/);
  });

  it('columnar/garbage first elements are named, not silently backtested', () => {
    expect(() =>
      backtest.vectorized({ data: [{ high: [1], low: [1], close: [1] }], signal: [1] } as never),
    ).toThrowError(/data\[0\] is not a bar/);
  });
});

describe('function-option boundary guards (dx review)', () => {
  const data = [flat(0, 100), flat(1, 101), flat(2, 102)];

  const catching = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('walkForward without `run` teaches the field instead of "options.run is not a function"', () => {
    const caught = catching(() => walkForward({ data, trainSize: 1, testSize: 2 } as never));
    expect(caught instanceof TypeError).toBe(false);
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as Error).message).toContain('run is required');
    expect((caught as Error).message).toContain('walkForward({'); // a minimal working call
    expect((caught as { code?: string }).code).toBe('input.missing_field');
  });

  it('walkForward with a non-function `run` is rejected the same way', () => {
    const caught = catching(() =>
      walkForward({ data, trainSize: 1, testSize: 2, run: 'vectorized' } as never),
    );
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as Error).message).toContain('run is required');
  });

  it('eventDriven without `strategy` teaches the field instead of "options.strategy is not a function"', () => {
    const caught = catching(() =>
      backtest.eventDriven({ data, broker: brokers.simulated({ cash: 1000 }) } as never),
    );
    expect(caught instanceof TypeError).toBe(false);
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as Error).message).toContain('strategy is required');
    expect((caught as Error).message).toContain('eventDriven({'); // a minimal working call
    expect((caught as { code?: string }).code).toBe('input.missing_field');
  });

  it('eventDriven without `broker` teaches the field instead of a property-read crash', () => {
    const caught = catching(() => backtest.eventDriven({ data, strategy() {} } as never));
    expect(caught instanceof TypeError).toBe(false);
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as Error).message).toContain('broker is required');
  });

  it('new SimulatedBroker(undefined) is a typed error, not a property-read crash', () => {
    const caught = catching(() => new SimulatedBroker(undefined as never));
    expect(caught instanceof TypeError).toBe(false);
    expect((caught as Error).message).toContain('config must be an object');
  });
});

describe('near-miss capital options are rejected, not silently ignored (dx review)', () => {
  it('vectorized({ initialCash }) points at initialCapital instead of running with capital 1', () => {
    const data = [flat(0, 100), flat(1, 101), flat(2, 102)];
    let caught: unknown;
    try {
      backtest.vectorized({ data, signal: [1, 1, 1], initialCash: 10_000 } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as Error).message).toContain('initialCash');
    expect((caught as Error).message).toContain('initialCapital');
    expect((caught as { code?: string }).code).toBe('input.unknown_field');
  });

  it('vectorized({ cash }) (the broker spelling) is rejected the same way', () => {
    const data = [flat(0, 100), flat(1, 101), flat(2, 102)];
    expect(() =>
      backtest.vectorized({ data, signal: [1, 1, 1], cash: 10_000 } as never),
    ).toThrowError(/initialCapital/);
  });
});
