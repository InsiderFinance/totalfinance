import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  ORDER_SIDES,
  ORDER_TYPES,
  TIME_IN_FORCE_VALUES,
  sideOf,
  signOf,
} from '@totalfinance/core';

/**
 * Pre-publish interface repairs B6 — one order vocabulary. Orders carry a side and a positive
 * quantity; held exposure is signed; `sideOf` / `signOf` are the one bridge between the two.
 */
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe('the order vocabulary', () => {
  it('spells every enum in kebab-case and closes the lists', () => {
    expect(ORDER_SIDES).toEqual(['buy', 'sell']);
    expect(ORDER_TYPES).toEqual([
      'market',
      'limit',
      'stop',
      'stop-limit',
      'market-on-open',
      'market-on-close',
    ]);
    expect(TIME_IN_FORCE_VALUES).toEqual(['day', 'gtc']);
    expect(Object.isFrozen(ORDER_TYPES)).toBe(true);
  });

  it('sideOf: positive buys, negative sells; zero and non-finite values have no side', () => {
    expect(sideOf(10)).toBe('buy');
    expect(sideOf(-0.5)).toBe('sell');
    expect(codeOf(() => sideOf(0))).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => sideOf(Number.NaN))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => sideOf(Number.POSITIVE_INFINITY))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => sideOf('10' as never))).toBe(ErrorCode.InputWrongType);
    expect(() => sideOf(0, 'rebalance')).toThrow(/^rebalance: /);
  });

  it('signOf: a buy is +1, a sell is −1, anything else is refused', () => {
    expect(signOf('buy')).toBe(1);
    expect(signOf('sell')).toBe(-1);
    expect(codeOf(() => signOf('BUY' as never))).toBe(ErrorCode.InputInvalidEnum);
    expect(signOf(sideOf(-3)) * 3).toBe(-3);
  });
});

describe('isTrustworthy reads one place: the diagnostics (C hygiene)', () => {
  it('converged !== false and no error-severity warning', async () => {
    const { isTrustworthy } = await import('@totalfinance/core');
    const ok = { diagnostics: { warnings: [] } };
    expect(isTrustworthy(ok)).toBe(true);
    expect(isTrustworthy({ diagnostics: { converged: true, warnings: [] } })).toBe(true);
    expect(isTrustworthy({ diagnostics: { converged: false, warnings: [] } })).toBe(false);
    expect(
      isTrustworthy({
        diagnostics: {
          warnings: [{ code: 'x', message: 'soft', severity: 'warn' }],
        },
      }),
    ).toBe(true);
    expect(
      isTrustworthy({
        diagnostics: {
          converged: true,
          warnings: [{ code: 'x', message: 'hard', severity: 'error' }],
        },
      }),
    ).toBe(false);
    expect(isTrustworthy(null)).toBe(false);
    expect(isTrustworthy({})).toBe(false);
    expect(isTrustworthy({ diagnostics: { warnings: null } })).toBe(false);
  });
});
