import { ErrorCode, InputError } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { vanillaIntrinsic } from '@totalfinance/options/payoff';
import { vanillaIntrinsic as vanillaIntrinsicFromRoot } from '@totalfinance/options';

/**
 * `vanillaIntrinsic` (platform roadmap, "One small primitive gap is worth closing"): gross intrinsic
 * value per unit, a bare number, with a CLOSED field set — no premium, quantity, multiplier,
 * probability, volatility, or time key. The tests pin both halves: the arithmetic and the boundary.
 */
describe('vanillaIntrinsic — values', () => {
  it('prices the roadmap examples exactly', () => {
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strike: 100 })).toBe(12);
    expect(vanillaIntrinsic({ type: 'put', underlyingPrice: 88, strike: 100 })).toBe(12);
  });

  it('is 0 out of the money and 0 at the money — never negative', () => {
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 88, strike: 100 })).toBe(0);
    expect(vanillaIntrinsic({ type: 'put', underlyingPrice: 112, strike: 100 })).toBe(0);
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 100, strike: 100 })).toBe(0);
    expect(vanillaIntrinsic({ type: 'put', underlyingPrice: 100, strike: 100 })).toBe(0);
  });

  it('a zero underlying or zero strike is LEGAL — intrinsic is still well-defined', () => {
    // A worthless underlying: the put is worth the full strike, the call nothing.
    expect(vanillaIntrinsic({ type: 'put', underlyingPrice: 0, strike: 100 })).toBe(100);
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 0, strike: 100 })).toBe(0);
    // A zero strike: the call is worth the full underlying, the put nothing.
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strike: 0 })).toBe(112);
    expect(vanillaIntrinsic({ type: 'put', underlyingPrice: 112, strike: 0 })).toBe(0);
    // Both zero: zero.
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 0, strike: 0 })).toBe(0);
  });

  it('is exact per unit — no multiplier, no premium netting', () => {
    // 1 unit deep ITM: exactly the moneyness, nothing scaled by 100, nothing netted.
    expect(vanillaIntrinsic({ type: 'call', underlyingPrice: 100.5, strike: 100 })).toBeCloseTo(
      0.5,
      15,
    );
  });

  it('is re-exported from the package root', () => {
    expect(vanillaIntrinsicFromRoot).toBe(vanillaIntrinsic);
  });
});

describe('vanillaIntrinsic — the closed boundary teaches', () => {
  const valid = { type: 'call', underlyingPrice: 112, strike: 100 } as const;

  it('rejects a missing argument object', () => {
    expect(() => (vanillaIntrinsic as unknown as () => number)()).toThrow(InputError);
  });

  it.each(['premium', 'quantity', 'multiplier', 'probability', 'volatility', 'timeToExpiryYears'])(
    'teaches on the excluded key %s instead of silently ignoring it',
    (key) => {
      const call = (): number =>
        vanillaIntrinsic({ ...valid, [key]: 1 } as unknown as Parameters<
          typeof vanillaIntrinsic
        >[0]);
      expect(call).toThrow(InputError);
      try {
        call();
      } catch (e) {
        expect((e as InputError).code).toBe(ErrorCode.InputUnknownField);
        expect((e as InputError).message).toContain(key);
      }
    },
  );

  it('teaches on a typo (Law 12), naming the unknown field', () => {
    expect(() =>
      vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strkie: 100 } as unknown as Parameters<
        typeof vanillaIntrinsic
      >[0]),
    ).toThrow(/strkie/);
  });

  it('the type enum is taught, not coerced', () => {
    for (const bad of ['Call', 'CALL', 'c', 'straddle']) {
      try {
        vanillaIntrinsic({ ...valid, type: bad as 'call' });
        expect.unreachable('accepted a non-canonical type');
      } catch (e) {
        expect(e).toBeInstanceOf(InputError);
        expect((e as InputError).code).toBe(ErrorCode.InputInvalidEnum);
      }
    }
  });

  it('a missing leg is named as MISSING, not "not finite"', () => {
    try {
      vanillaIntrinsic({ type: 'call', underlyingPrice: 112 } as Parameters<
        typeof vanillaIntrinsic
      >[0]);
      expect.unreachable('accepted a missing strike');
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as InputError).code).toBe(ErrorCode.InputMissingField);
      expect((e as InputError).message).toContain('strike');
    }
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite prices (%s)', (bad) => {
    expect(() => vanillaIntrinsic({ ...valid, underlyingPrice: bad })).toThrow(InputError);
    expect(() => vanillaIntrinsic({ ...valid, strike: bad })).toThrow(InputError);
  });

  it('rejects a negative underlyingPrice or strike with the taught codes', () => {
    try {
      vanillaIntrinsic({ ...valid, underlyingPrice: -1 });
      expect.unreachable('accepted a negative underlying');
    } catch (e) {
      expect((e as InputError).code).toBe(ErrorCode.InputNegativeSpot);
    }
    try {
      vanillaIntrinsic({ ...valid, strike: -1 });
      expect.unreachable('accepted a negative strike');
    } catch (e) {
      expect((e as InputError).code).toBe(ErrorCode.InputNegativeStrike);
    }
  });
});
