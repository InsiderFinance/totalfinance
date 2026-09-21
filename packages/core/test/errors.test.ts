import { describe, expect, it } from 'vitest';
import {
  ConvergenceError,
  ErrorCode,
  InputError,
  QuantError,
  ensureEnum,
  ensureFinite,
  isQuantError,
} from '@totalfinance/core';

describe('QuantError', () => {
  it('carries a stable code and structured context', () => {
    const err = new InputError('spot must be > 0. Received -12.', {
      code: ErrorCode.InputNegativeSpot,
      context: { field: 'spot', value: -12, function: 'blackScholes.call' },
    });
    expect(err).toBeInstanceOf(QuantError);
    expect(err).toBeInstanceOf(InputError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('input.negative_spot');
    expect(err.name).toBe('InputError');
    expect(err.context).toEqual({ field: 'spot', value: -12, function: 'blackScholes.call' });
  });

  it('preserves the cause chain', () => {
    const cause = new Error('root');
    const err = new ConvergenceError('did not converge', {
      code: ErrorCode.ImpliedVolatilityNoConvergence,
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('isQuantError narrows by code', () => {
    const err: unknown = new InputError('bad', { code: ErrorCode.InputNaN });
    expect(isQuantError(err)).toBe(true);
    expect(isQuantError(err, 'input.nan')).toBe(true);
    expect(isQuantError(err, 'implied_volatility.no_convergence')).toBe(false);
    expect(isQuantError(new Error('plain'))).toBe(false);
  });
});

describe('describe() hardening — the teaching-error factory never crashes', () => {
  it('BigInt garbage gets described, not thrown at (JSON.stringify cannot serialize it)', () => {
    expect(() => ensureFinite(100n as never, 'spot', 'blackScholes.call')).toThrowError(
      /100n \(bigint\)/,
    );
  });

  it('undefined/null read cleanly, not as "undefined (undefined)"', () => {
    try {
      ensureFinite(undefined as never, 'spot', 'blackScholes.call');
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('undefined');
      expect(msg).not.toContain('undefined (undefined)');
    }
  });

  it('typed invariant errors and their JSON form never execute caller hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('toJSON must not execute');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('Symbol.toPrimitive must not execute');
      },
    };

    for (const run of [
      () => ensureFinite(hostile as never, 'spot', 'probe'),
      () => ensureEnum(hostile, ['call', 'put'], 'type', 'probe'),
    ]) {
      try {
        run();
        expect.unreachable('accepted hostile input');
      } catch (error) {
        expect(isQuantError(error)).toBe(true);
        expect(() => JSON.stringify(error)).not.toThrow();
      }
    }
    expect(calls).toBe(0);
  });
});
