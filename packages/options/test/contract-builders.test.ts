import { describe, expect, it } from 'vitest';
import { resolvedExpiry, usEquityCloseUtcMs } from '@totalfinance/core';
import { engines, market, option } from '@totalfinance/options';

/**
 * Alignment-spec P3.4 — contracts are VALID BY CONSTRUCTION. A builder's name is a promise:
 * meaning-changing fields are required (style is never guessed), numerics are validated at
 * construction, the expiry label resolves to its exact instant HERE with the convention stamped,
 * and the instrument builders encode the US listed convention in their names.
 */

describe('generic builders require style (P3.4 — no unsafe European default)', () => {
  const base = { underlying: 'AAPL', strike: 100, expiry: '2026-09-18' };

  it('option.call without style teaches the choice and the instrument builders', () => {
    expect(() => option.call(base as never)).toThrow(
      /style is required — one of 'european' \| 'american'.*usEquityCall/s,
    );
  });

  it('a mistyped style is rejected, never coerced', () => {
    expect(() => option.call({ ...base, style: 'European' as never })).toThrow(/style is required/);
  });
});

describe('builder-level validation (never a contract that cannot price)', () => {
  const ok = { underlying: 'AAPL', strike: 100, expiry: '2026-09-18', style: 'american' } as const;

  it('rejects a blank underlying', () => {
    expect(() => option.call({ ...ok, underlying: '  ' })).toThrow(/non-blank symbol/);
  });

  it('rejects non-positive strike and multiplier', () => {
    expect(() => option.call({ ...ok, strike: -5 })).toThrow(/strike/);
    expect(() => option.call({ ...ok, multiplier: 0 })).toThrow(/multiplier/);
  });

  it('rejects an invalid expiry AT BUILD (2026-02-31 never rolls; zone-less datetimes teach)', () => {
    expect(() =>
      option.call({ convention: 'us-equity-close', ...ok, expiry: '2026-02-31' }),
    ).toThrow();
    expect(() => option.call({ ...ok, expiry: '2026-09-18T16:00' })).toThrow(/no timezone/);
  });
});

describe('expiry resolution is stamped on the contract at build', () => {
  it('date-only expiry → exact 16:00 ET instant + named convention', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'SPX',
      strike: 6000,
      expiry: '2026-09-18',
      style: 'european',
    });
    expect(c.expiresAt).toBe(usEquityCloseUtcMs(2026, 9, 18));
    expect(c.expiryConvention).toBe('us-equity-close');
  });

  it('zoned datetime expiry → the explicit instant', () => {
    const c = option.call({
      underlying: 'SPX',
      strike: 6000,
      expiry: '2026-09-18T13:00:00-04:00',
      style: 'european',
    });
    expect(c.expiresAt).toBe(Date.parse('2026-09-18T13:00:00-04:00'));
    expect(c.expiryConvention).toBe('explicit-instant');
  });
});

describe('instrument builders — the convention lives in the name', () => {
  it('usEquityCall: American, us-equity-close, ×100 multiplier by default', () => {
    const c = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
    expect(c.style).toBe('american');
    expect(c.type).toBe('call');
    expect(c.multiplier).toBe(100);
    expect(c.expiryConvention).toBe('us-equity-close');
  });

  it('usEquityPut mirrors it; an explicit multiplier wins (adjusted contracts exist)', () => {
    const c = option.usEquityPut({
      underlying: 'AAPL',
      strike: 200,
      expiry: '2026-09-18',
      multiplier: 150,
    });
    expect(c.style).toBe('american');
    expect(c.type).toBe('put');
    expect(c.multiplier).toBe(150);
  });

  it('european names the exercise style AND requires the expiry instant to be explicit (C3)', () => {
    // Date-only without a named convention: silent economics — rejected with the fix.
    expect(() =>
      option.european({ type: 'put', underlying: 'SPX', strike: 6000, expiry: '2026-12-18' }),
    ).toThrow(/convention/);
    const c = option.european({
      convention: 'us-equity-close',
      type: 'put',
      underlying: 'SPX',
      strike: 6000,
      expiry: '2026-12-18',
    });
    expect(c.style).toBe('european');
    expect(c.type).toBe('put');
    expect(c.expiryConvention).toBe('us-equity-close');
    // A mistyped type is rejected, never coerced (design law #4).
    expect(() =>
      option.european({
        convention: 'us-equity-close',
        type: 'CALL' as never,
        underlying: 'SPX',
        strike: 6000,
        expiry: '2026-12-18',
      }),
    ).toThrow(/type/);
  });

  it('built contracts are FROZEN artifacts; engines reject a mutated expiry (C3)', () => {
    const c = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => {
      (c as { expiry: string }).expiry = '2027-01-15';
    }).toThrow(); // strict mode: assignment to a frozen object throws

    // The reviewer's probe: a spread-copied contract with a divergent expiry label can no longer
    // silently price a different instant — engines cross-check expiry ↔ expiresAt.
    const mutated = { ...c, expiry: '2027-01-15' };
    expect(() =>
      option.price({
        contract: mutated,
        market: market({
          spot: 195,
          riskFreeRate: 0.04,
          volatility: 0.2,
          asOf: '2026-07-20T00:00:00Z',
        }),
      }),
    ).toThrow(/mutated after|resolves to/);
  });

  it('EVERY engine family rejects the mutated contract — the law is not engine-dependent (D2)', () => {
    const euro = option.european({
      convention: 'us-equity-close',
      type: 'call',
      underlying: 'X',
      strike: 100,
      expiry: '2026-12-18',
    });
    const mutated = { ...euro, expiry: '2027-06-18' };
    const mkt = market({
      spot: 100,
      riskFreeRate: 0.04,
      volatility: 0.2,
      asOf: '2026-07-20T00:00:00Z',
    });
    const fwdMkt = market({
      spot: 100,
      forward: 101,
      riskFreeRate: 0.04,
      volatility: 0.2,
      asOf: '2026-07-20T00:00:00Z',
    });
    const families = [
      ['bsm', () => engines.blackScholesMerton().price({ contract: mutated, market: mkt })],
      ['black-76', () => engines.black76().price({ contract: mutated, market: fwdMkt })],
      [
        'heston',
        () =>
          engines
            .heston({ v0: 0.04, theta: 0.04, kappa: 1.5, sigma: 0.3, rho: -0.5 })
            .price({ contract: mutated, market: mkt }),
      ],
      [
        'sabr',
        () =>
          engines
            .sabr({ alpha: 0.2, beta: 1, rho: -0.2, nu: 0.4 })
            .price({ contract: mutated, market: fwdMkt }),
      ],
      [
        'monte-carlo',
        () =>
          engines.monteCarlo({ paths: 1000, seed: 1 }).price({ contract: mutated, market: mkt }),
      ],
    ] as const;
    for (const [label, run] of families) {
      expect(run, label).toThrow(/mutated after construction/);
    }
  });
});

describe('usEquityOption — the US listed contract from DATA (repairs B7)', () => {
  const fields = { underlying: 'AAPL', strike: 105, expiry: '2026-09-18' };

  it('with `type` it is exactly the named builder', () => {
    expect(option.usEquityOption({ type: 'call', ...fields })).toEqual(option.usEquityCall(fields));
    expect(option.usEquityOption({ type: 'put', ...fields })).toEqual(option.usEquityPut(fields));
  });

  it('with an OCC symbol it reads root, expiry, type and strike from the symbol', () => {
    const c = option.usEquityOption({ occSymbol: 'AAPL260918C00105000' });
    expect(c).toMatchObject({
      underlying: 'AAPL',
      root: 'AAPL',
      type: 'call',
      style: 'american',
      strike: 105,
      expiry: '2026-09-18',
      expiryConvention: 'us-equity-close',
      multiplier: 100,
      occSymbol: 'AAPL260918C00105000',
    });
    expect(c.expiresAt).toBe(resolvedExpiry('2026-09-18').expiresAt);
    expect(Object.isFrozen(c)).toBe(true);
    expect(option.usEquityOption({ occSymbol: 'SPY260320P00450500' })).toMatchObject({
      type: 'put',
      strike: 450.5,
      expiry: '2026-03-20',
    });
  });

  it('the symbol names the root; the underlying may differ, and adjusted multipliers pass through', () => {
    const weekly = option.usEquityOption({ occSymbol: 'SPXW260320C05000000', underlying: 'SPX' });
    expect(weekly.root).toBe('SPXW');
    expect(weekly.underlying).toBe('SPX');
    const adjusted = option.usEquityOption({ occSymbol: 'AAPL260918C00105000', multiplier: 110 });
    expect(adjusted.multiplier).toBe(110);
  });

  it('a field beside the symbol must agree with it — a contradiction is refused, never resolved', () => {
    expect(() => option.usEquityOption({ occSymbol: 'AAPL260918C00105000', strike: 100 })).toThrow(
      /strike 100 contradicts occSymbol's 105/,
    );
    expect(() => option.usEquityOption({ occSymbol: 'AAPL260918C00105000', type: 'put' })).toThrow(
      /type "put" contradicts occSymbol's "call"/,
    );
    expect(() =>
      option.usEquityOption({ occSymbol: 'AAPL260918C00105000', expiry: '2026-09-25' }),
    ).toThrow(/expiry/);
    expect(() => option.usEquityOption({ occSymbol: 'SPXW260320C05000000', root: 'SPX' })).toThrow(
      /root "SPX" contradicts/,
    );
    // Agreement is fine — the caller is allowed to be redundant.
    expect(
      option.usEquityOption({ occSymbol: 'AAPL260918C00105000', type: 'call', strike: 105 }).strike,
    ).toBe(105);
  });

  it('without a symbol, `type` is required and taught; unknown keys and bad symbols are refused', () => {
    expect(() => option.usEquityOption(fields)).toThrow(/type \('call' \| 'put'\) is required/);
    expect(() => option.usEquityOption({ type: 'Call' as never, ...fields })).toThrow(/type/);
    expect(() =>
      option.usEquityOption({ type: 'call', ...fields, style: 'american' } as never),
    ).toThrow(/style/);
    expect(() => option.usEquityOption({ occSymbol: 'not-a-symbol' })).toThrow(/OCC/);
    expect(() => option.usEquityOption({ occSymbol: '' })).toThrow(/non-empty OCC/);
  });
});
